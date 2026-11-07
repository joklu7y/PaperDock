'use client';

import { useState } from 'react';
import { FileCode2, FileSpreadsheet, FileText, LayoutTemplate, Table2 } from 'lucide-react';
import { formOf, useWorkbench } from '../api';
import { Card, Chip, DropZone, PageHeader, ToolButton } from '../ui';

export default function TablesView() {
  const { post, saveResponse, notify, busy } = useWorkbench();
  const [files, setFiles] = useState<File[]>([]);
  const [language, setLanguage] = useState('ch');
  const [running, setRunning] = useState('');

  const tables = async (output: 'xlsx' | 'csv') => {
    if (!files.length) return notify('请先选择 PDF 或图片。');
    setRunning(output);
    try {
      const response = await post('/tables/extract', formOf({ files, language, output }), '正在识别表格');
      const count = response?.headers.get('X-PaperDock-Tables');
      if (await saveResponse(response, output === 'csv' ? 'tables-csv.zip' : 'tables.xlsx')) notify(`已提取 ${count || ''} 个表格，每个表格一个工作表。请核对合并单元格。`);
    } finally { setRunning(''); }
  };
  const layout = async (target: 'layout-docx' | 'md') => {
    if (!files.length) return notify('请先选择 PDF 或图片。');
    if (files.length > 1) notify('版面还原一次处理一个文件，将使用第一个文件。');
    setRunning(target);
    try {
      await saveResponse(await post('/convert/extra', formOf({ file: files[0], target, language }), '正在还原版面'), target === 'md' ? 'document.md' : 'layout.docx');
    } finally { setRunning(''); }
  };

  return (
    <div className="md-view mx-auto max-w-5xl">
      <PageHeader title="表格与版面" subtitle="扫描的实验数据表直接变 Excel；双栏教材、图文混排按阅读顺序还原成 Word。" />
      <Card>
        <DropZone files={files} onFiles={setFiles} accept=".pdf,.png,.jpg,.jpeg,.bmp,.tif,.tiff" multiple label="选择 PDF 或图片" hint="表格提取最多 10 个文件；电子版 PDF 直接读取，扫描件和照片自动 OCR。" />
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-sm text-m-on-surface-variant">识别语言</span>
          <Chip selected={language === 'ch'} onClick={() => setLanguage('ch')}>中文 / 中英混合</Chip>
          <Chip selected={language === 'en'} onClick={() => setLanguage('en')}>英文</Chip>
        </div>
      </Card>
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <Card title="表格识别" subtitle="保留行列结构，每个表格一个工作表">
          <div className="grid gap-3">
            <ToolButton icon={FileSpreadsheet} title="提取为 Excel" description="带框线的表格按单元格还原；无框线表格按列对齐推断。" loading={running === 'xlsx'} disabled={busy} onClick={() => void tables('xlsx')} />
            <ToolButton icon={Table2} title="提取为 CSV" description="每个表格一个 CSV（UTF-8，Excel 可直接打开），打包为 ZIP。" loading={running === 'csv'} disabled={busy} onClick={() => void tables('csv')} />
          </div>
        </Card>
        <Card title="版面还原" subtitle="多栏 → 正确阅读顺序；页眉页脚分离；保留图片和表格">
          <div className="grid gap-3">
            <ToolButton icon={LayoutTemplate} title="还原为 Word" description="页眉页脚放进 Word 页眉页脚；电子版 PDF 中的表格转为 Word 表格。" loading={running === 'layout-docx'} disabled={busy} onClick={() => void layout('layout-docx')} />
            <ToolButton icon={FileCode2} title="导出 Markdown" description="适合放进笔记软件或给 AI 阅读，表格转为 Markdown 表格。" loading={running === 'md'} disabled={busy} onClick={() => void layout('md')} />
          </div>
        </Card>
      </div>
      <p className="mt-6 flex items-start gap-2 text-xs leading-5 text-m-on-surface-variant"><FileText size={14} className="mt-0.5 shrink-0" />扫描件中的图片暂不单独抠出；复杂合并单元格可能被拆开，导出后建议快速核对一遍。</p>
    </div>
  );
}
