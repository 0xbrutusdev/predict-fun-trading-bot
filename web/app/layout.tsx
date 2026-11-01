import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Predict.fun · 量化控制台",
  description:
    "Predict.fun 预测市场量化交易控制台：策略、账户、风险与运行监控。",
  robots: { index: false, follow: false },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
