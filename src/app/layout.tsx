import type { Metadata, Viewport } from 'next';
import './globals.css';
// System CJK fonts (PingFang SC / Microsoft YaHei / Noto Sans CJK) are used directly; see --font-sans in globals.css.
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#111c30' };
export const metadata: Metadata = { title: '百变小克的影视工坊', description: '光影留痕，观影有迹。你的私人影视记忆档案。', robots: {index:false,follow:false}, icons: {icon:[{url:'/logo-bird.svg',type:'image/svg+xml'},{url:'/favicon-bird.ico',sizes:'any'},{url:'/favicon-32.png',type:'image/png',sizes:'32x32'}],apple:'/apple-touch-icon.png'} };
export default function RootLayout({children}:{children:React.ReactNode}) { return <html lang="zh-CN"><body>{children}</body></html>; }
