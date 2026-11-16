import { redirect } from 'next/navigation';
import { ArchiveDashboard } from '@/components/archive-dashboard';
import { pageSession } from '@/lib/server/session';
import { loadArchiveSnapshot } from '@/lib/server/archive';
export const dynamic='force-dynamic';
export default async function Page(){
 const session=await pageSession();if(!session)redirect('/login');
 const {data:initialData,etag}=await loadArchiveSnapshot(session.ownerId,session.csrf);
 return <ArchiveDashboard initialData={{...initialData,etag}}/>;
}
