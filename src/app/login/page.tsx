import { redirect } from 'next/navigation';
import { pageSession } from '@/lib/server/session';
import { authReady } from '@/lib/server/config';
export const dynamic='force-dynamic';
const errors:Record<string,string>={state:'登录请求已过期或浏览器校验未通过。请从本站重新点击授权登录。',account:'本次授权账号不在本站允许范围内，请使用指定的 Trakt 账号。',trakt_blocked:'Trakt 暂时拦截了服务器请求，请稍后重试。',token:'Trakt 授权码交换未完成，请重新发起授权。',profile:'未能读取 Trakt 账号信息，请稍后重试授权。',storage:'本站保存授权信息时失败，请联系维护者检查。',session:'本站建立登录会话时失败，请联系维护者检查。',configuration:'本站授权配置尚未完成。',rate_limited:'登录尝试过于频繁，请 10 分钟后再试。',busy:'当前登录请求过多，请稍后再试。'};
export default async function Login({searchParams}:{searchParams:Promise<{error?:string}>}){
 if(await pageSession())redirect('/');const ready=authReady(),error=(await searchParams).error;
 return <main className="login-shell"><section className="panel login-card"><img src="/logo-bird.svg" width={58} height={58} alt="影视工坊 Logo"/><p className="eyebrow"><span/>私人光影档案</p><h1>百变小克的影视工坊</h1><h2>光影留痕，观影有迹。</h2><p>通过 Trakt 官方页面登录，查看你的私人观影档案。<br/>自动同步只读取记录；仅在你主动确认后添加历史，不收集账号密码。</p>{error&&<p className="login-error" role="alert">{errors[error]||'授权未完成，请从本站重新发起登录。'}</p>}{ready?<a className="primary-button" href="/api/auth/login">使用 Trakt 授权登录 →</a>:<div className="settings-status">真实数据模式已启用，等待配置 Trakt Client ID 与 HTTPS 测试回调地址。</div>}<p className="settings-help">未登录不会加载个人观看记录，也不会使用模拟记录填充统计。</p><p className="settings-help">数据同步自 Trakt · 本站为独立私人档案，不受 Trakt 官方背书</p></section></main>;
}
