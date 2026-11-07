'use client';

import { useState } from 'react';
import { Eraser, Eye, EyeOff, FileWarning, LockKeyhole, LockKeyholeOpen, ScanEye, Wrench } from 'lucide-react';
import { formOf, useWorkbench } from '../api';
import { Button, Card, Chip, DropZone, Field, PageHeader } from '../ui';

const permissionOptions = [['copy', '允许复制'], ['print', '允许打印'], ['modify', '允许修改 / 批注 / 填表']] as const;

export default function SecurityView() {
  const { post, saveResponse, notify, busy } = useWorkbench();
  const [file, setFile] = useState<File[]>([]);
  const [password, setPassword] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [redact, setRedact] = useState('');

  const secure = async (operation: string) => {
    if (!file.length) return notify('请先选择 PDF。');
    if (operation === 'protect' && (!password || !ownerPassword)) return notify('请同时填写打开密码和所有者密码。');
    if (operation === 'unlock' && !password) return notify('移除密码前请输入打开密码。');
    await saveResponse(await post(`/security/${operation}`, formOf({ file: file[0], password, owner_password: ownerPassword, redact_text: redact, permissions: JSON.stringify(permissions) }), '正在处理安全操作'), operation === 'unlock' ? 'unlocked.pdf' : 'secured.pdf');
  };
  const repair = async () => {
    if (!file.length) return notify('请先选择 PDF。');
    const response = await post('/pdf/repair', formOf({ file: file[0] }), '正在修复 PDF');
    const [method, pages] = (response?.headers.get('X-PaperDock-Repair') || '').split('|');
    if (await saveResponse(response, 'repaired.pdf')) notify(`修复完成：${method === 'qpdf' ? 'qpdf 深度恢复' : '结构重建'}，共 ${pages} 页。`);
  };

  return (
    <div className="md-view mx-auto max-w-4xl">
      <PageHeader title="安全与修复" subtitle="加密码、限制权限、永久涂黑、清理隐私信息，修复打不开的 PDF。" />
      <Card><DropZone files={file} onFiles={setFile} accept=".pdf" label="选择 PDF" compact /></Card>
      <Card className="mt-6" title="密码与权限" subtitle="AES-256 加密；仅能移除由 PaperDock 加密的文件">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="打开密码" type={visible ? 'text' : 'password'} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} hint="至少 12 位，含大小写字母、数字和符号" />
          <Field label="所有者密码" type={visible ? 'text' : 'password'} autoComplete="new-password" value={ownerPassword} onChange={(e) => setOwnerPassword(e.target.value)} hint="须与打开密码不同，用于锁定权限" />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {permissionOptions.map(([id, label]) => <Chip key={id} selected={permissions.includes(id)} onClick={() => setPermissions((old) => (old.includes(id) ? old.filter((x) => x !== id) : [...old, id]))}>{label}</Chip>)}
          <Button variant="text" icon={visible ? EyeOff : Eye} onClick={() => setVisible((v) => !v)}>{visible ? '隐藏密码' : '显示密码'}</Button>
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="outlined" icon={LockKeyholeOpen} disabled={busy} onClick={() => void secure('unlock')}>移除密码</Button>
          <Button variant="filled" icon={LockKeyhole} disabled={busy} onClick={() => void secure('protect')}>加密保存</Button>
        </div>
      </Card>
      <Card className="mt-6" title="永久涂黑" subtitle="匹配的文字会被真正删除并盖黑，无法恢复；操作前请保留原件">
        <textarea className="md-input h-24" value={redact} onChange={(e) => setRedact(e.target.value)} placeholder={'每行一项，例如：\n身份证号\n手机号'} />
        <div className="mt-4 flex justify-end"><Button variant="danger" icon={ScanEye} disabled={busy} onClick={() => void secure('redact')}>永久涂黑</Button></div>
      </Card>
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <Card title="清理元数据" subtitle="删除作者、软件、修改记录等隐藏信息">
          <Button variant="tonal" icon={Eraser} disabled={busy} onClick={() => void secure('clean-metadata')}>清理并保存</Button>
        </Card>
        <Card title="修复损坏的 PDF" subtitle="重建交叉引用表；失败时自动换用 qpdf 深度恢复">
          <Button variant="tonal" icon={Wrench} disabled={busy} onClick={() => void repair()}>尝试修复</Button>
        </Card>
      </div>
      <p className="mt-6 flex items-start gap-2 text-xs text-m-on-surface-variant"><FileWarning size={14} className="mt-0.5 shrink-0" />修复属于“尽力而为”：严重缺损的文件可能只能恢复部分页面。</p>
    </div>
  );
}
