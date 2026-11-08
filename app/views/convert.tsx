'use client';

import { useEffect, useState } from 'react';
import { BookOpen, Camera, FileCode2, FileImage, FileSpreadsheet, FileText, FileType2, Images, LayoutTemplate, Presentation } from 'lucide-react';
import { formOf, readError, useWorkbench } from '../api';
import { mobileWorkbench } from '../platform';
import { Button, Card, DropZone, PageHeader, ToolButton } from '../ui';

type Target = { id: string; title: string; description: string; icon: typeof FileText; extra?: boolean; fallback: string };
const fromPdf: Target[] = [
  { id: 'docx', title: 'Word（纯文字）', description: '提取文字；文字编码异常时自动 OCR', icon: FileText, fallback: 'converted.docx' },
  { id: 'layout-docx', title: 'Word（版面还原）', description: '多栏阅读顺序、页眉页脚、图片和表格', icon: LayoutTemplate, extra: true, fallback: 'layout.docx' },
  { id: 'xlsx', title: 'Excel（逐行文字）', description: '需要单元格结构请用“表格与版面”', icon: FileSpreadsheet, fallback: 'converted.xlsx' },
  { id: 'pptx', title: 'PowerPoint', description: '每页一张幻灯片，文字放在备注里', icon: Presentation, extra: true, fallback: 'slides.pptx' },
  { id: 'odt', title: 'ODT（WPS / LibreOffice）', description: '开放文档格式', icon: FileType2, extra: true, fallback: 'document.odt' },
  { id: 'epub', title: 'EPUB 电子书', description: '每页一章，适合手机阅读器', icon: BookOpen, extra: true, fallback: 'document.epub' },
  { id: 'md', title: 'Markdown', description: '笔记软件 / AI 友好', icon: FileCode2, extra: true, fallback: 'document.md' },
  { id: 'txt', title: '纯文本 TXT', description: '仅文字', icon: FileText, fallback: 'converted.txt' },
  { id: 'images', title: '每页一张图片', description: 'PNG 打包为 ZIP', icon: Images, fallback: 'pages.zip' },
  { id: 'embedded-images', title: '提取内嵌图片', description: '导出 PDF 里原始的图片素材', icon: FileImage, extra: true, fallback: 'embedded-images.zip' },
];

export default function ConvertView() {
  const { post, saveResponse, notify, busy } = useWorkbench();
  const [images, setImages] = useState<File[]>([]);
  const [pdf, setPdf] = useState<File[]>([]);
  const [running, setRunning] = useState('');

  // Paste screenshots directly into the image → PDF list.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const pasted = Array.from(event.clipboardData?.files || []).filter((f) => f.type.startsWith('image/'));
      if (pasted.length) setImages((old) => [...old, ...pasted.map((f, i) => new File([f], `截图-${Date.now()}-${i + 1}.png`, { type: f.type }))].slice(0, 10));
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);
  const snip = async () => {
    notify(mobileWorkbench ? '请选择一张手机截图。' : '请框选屏幕区域（Esc 取消）。');
    const response = await post('/capture/snip', new FormData(), '等待截图');
    if (!response) return;
    if (!response.ok) return notify(await readError(response, '截图失败'));
    const blob = await response.blob();
    const extension = blob.type === 'image/jpeg' ? 'jpg' : 'png';
    setImages((old) => [...old, new File([blob], `截图-${new Date().toLocaleTimeString().replaceAll(':', '')}.${extension}`, { type: blob.type })].slice(0, 10));
  };
  const convert = async (target: Target) => {
    if (!pdf.length) return notify('请先选择 PDF。');
    setRunning(target.id);
    try {
      const response = target.extra
        ? await post('/convert/extra', formOf({ file: pdf[0], target: target.id }), `正在转换为 ${target.title}`)
        : await post('/convert', formOf({ files: pdf, target: target.id }), `正在转换为 ${target.title}`);
      await saveResponse(response, target.fallback);
    } finally { setRunning(''); }
  };

  return (
    <div className="md-view mx-auto max-w-5xl">
      <PageHeader title="格式转换" subtitle="图片和截图转 PDF；PDF 导出为 Office、电子书、Markdown 等格式。" />
      <Card title="图片 / 截图 → PDF" subtitle={mobileWorkbench ? '最多 10 张，按列表顺序成页。' : '最多 10 张，按列表顺序成页；可 Ctrl+V 粘贴截图'}>
        <DropZone files={images} onFiles={setImages} accept=".png,.jpg,.jpeg,.bmp,.tif,.tiff" multiple label="选择图片" compact />
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="outlined" icon={Camera} disabled={busy} onClick={() => void snip()}>{mobileWorkbench ? '导入截图' : '截取屏幕'}</Button>
          <Button variant="filled" icon={FileImage} disabled={!images.length || busy} onClick={async () => { await saveResponse(await post('/convert', formOf({ files: images, target: 'pdf' }), '正在生成 PDF'), 'converted.pdf'); }}>生成 PDF</Button>
        </div>
      </Card>
      <Card className="mt-6" title="PDF → 其他格式" subtitle="扫描件会自动使用 OCR（首次较慢）">
        <DropZone files={pdf} onFiles={setPdf} accept=".pdf" label="选择 PDF" compact />
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {fromPdf.map((t) => <ToolButton key={t.id} icon={t.icon} title={t.title} description={t.description} loading={running === t.id} disabled={busy} onClick={() => void convert(t)} />)}
        </div>
      </Card>
    </div>
  );
}
