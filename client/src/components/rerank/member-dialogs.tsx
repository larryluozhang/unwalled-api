import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// che.32: 重排成员管理对话框——平台限于有 rerank 适配器的五家。

const ADAPTER_PLATFORMS = [
  { value: 'siliconflow-cn', label: 'SiliconFlow 国内站' },
  { value: 'siliconflow', label: 'SiliconFlow 国际站' },
  { value: 'jina', label: 'Jina' },
  { value: 'cohere', label: 'Cohere' },
]

export function AddRerankMemberDialog({ defaultFamily, open, onClose }: { defaultFamily: string; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [platform, setPlatform] = useState(ADAPTER_PLATFORMS[0].value)
  const [modelId, setModelId] = useState('')
  const [family, setFamily] = useState(defaultFamily)
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/api/rerank/member', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rerank'] })
      setModelId('')
      setError(null)
      onClose()
    },
    onError: (err: any) => setError(err?.message ?? 'failed'),
  })

  function submit() {
    setError(null)
    mutation.mutate({
      platform,
      modelId: modelId.trim(),
      family: family.trim() || undefined,
    })
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose() }}>
      <DialogPopup>
        <div className="mb-2">
          <DialogTitle>添加重排成员</DialogTitle>
          <DialogDescription>把某个平台的重排模型注册进 family 链（family 只允许同模型：分数分布跨模型不可比）</DialogDescription>
        </div>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>平台</Label>
            <select
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={platform}
              onChange={e => setPlatform(e.target.value)}
            >
              {ADAPTER_PLATFORMS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>模型 ID</Label>
            <Input placeholder="BAAI/bge-reranker-v2-m3" value={modelId} onChange={e => setModelId(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Family（留空 = 用模型 ID 新建）</Label>
            <Input value={family} onChange={e => setFamily(e.target.value)} />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
            <Button size="sm" onClick={submit} disabled={!modelId.trim() || mutation.isPending}>
              {mutation.isPending ? '注册中…' : '注册'}
            </Button>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  )
}

export function EditRerankFamilyDialog({
  providerId, modelId, currentFamily, open, onClose,
}: { providerId: number; modelId: string; currentFamily: string; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [family, setFamily] = useState(currentFamily)
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: (f: string) => apiFetch(`/api/rerank/${providerId}/family`, { method: 'PUT', body: JSON.stringify({ family: f }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rerank'] })
      setError(null)
      onClose()
    },
    onError: (err: any) => setError(err?.message ?? 'failed'),
  })

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose() }}>
      <DialogPopup>
        <div className="mb-2">
          <DialogTitle>修改 family 归属</DialogTitle>
          <DialogDescription className="font-mono text-xs">{modelId}（当前：{currentFamily}）</DialogDescription>
        </div>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>目标 family（只允许同模型）</Label>
            <Input value={family} onChange={e => setFamily(e.target.value)} />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
            <Button size="sm" onClick={() => mutation.mutate(family.trim())} disabled={!family.trim() || mutation.isPending}>
              {mutation.isPending ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  )
}
