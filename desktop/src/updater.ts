// che: electron-updater 自动升级（GitHub Releases 源，unwalled-api 仓）
// 启动后静默检查；下载完成后弹框询问"立即重启升级/稍后"。
// 升级源由 electron-builder.yml 的 publish.github（larryluozhang/unwalled-api）决定，
// 需要 release 里带 latest-mac.yml + zip + dmg（本仓 dist 产物已含）。
import { app, dialog } from 'electron';
import electronUpdater from 'electron-updater';

export function initAutoUpdater(): void {
  if (process.env.UNWALLED_NO_AUTO_UPDATE) return;
  if (!app.isPackaged) return; // 开发模式不检查

  // che.3 加固：autoUpdater 的 getter 会构造平台 updater（mac 为 MacUpdater），
  // 若在模块顶层解构，任何意外都会在模块加载期炸掉整个主进程（连错误框都没有）。
  // 挪进 isPackaged 守卫之后，并整体包 try——升级器永远不能是启动失败的原因。
  let autoUpdater: typeof electronUpdater.autoUpdater;
  try {
    ({ autoUpdater } = electronUpdater);
  } catch (e) {
    console.warn('[updater] autoUpdater unavailable:', (e as Error)?.message);
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', async (info) => {
    try {
      const r = await dialog.showMessageBox({
        type: 'info',
        title: 'Unwalled API 更新就绪',
        message: `新版本 ${info.version} 已下载完成。`,
        detail: '重启应用完成升级。',
        buttons: ['立即重启升级', '稍后'],
        defaultId: 0,
        cancelId: 1,
      });
      if (r.response === 0) autoUpdater.quitAndInstall();
    } catch {
      // 窗口可能已关；autoInstallOnAppQuit 会在退出时自动安装
    }
  });
  autoUpdater.on('error', (e) => console.warn('[updater]', e.message));

  void autoUpdater.checkForUpdates().catch(() => undefined);
  // 每 6 小时复查一次
  setInterval(() => { void autoUpdater.checkForUpdates().catch(() => undefined); }, 6 * 60 * 60 * 1000).unref();
}
