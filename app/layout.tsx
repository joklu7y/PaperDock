import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PaperDock — 个人文档工作台',
  description: 'OCR、PDF 编辑、转换与文档安全的一体化工作台。',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
