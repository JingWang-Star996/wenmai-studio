import type { Metadata } from "next";
import "./globals.css";
import ManagementSessionGate from "./ManagementSessionGate";

export const metadata: Metadata = {
  title: {
    default: "文脉 · 本地文章工程台",
    template: "%s · 文脉",
  },
  description: "在本地继续一篇文章：整理资料、编辑正文、保留分支与修订，并把 Build、平台提交、后台记录、公开页面和效果证据分开核验。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body><ManagementSessionGate>{children}</ManagementSessionGate></body>
    </html>
  );
}
