import type { WatchEvent, Work } from './archive';
export interface ArchiveData {
 events: WatchEvent[];works: Work[];
 owner:{username:string;timezone:string;hasAvatar:boolean;avatarVersion?:string|null};
 csrf:string;
 etag?:string;
 sync:{status:string;mode:string|null;completedPage:number;completedCount:number;expectedCount:number|null;lastCheckedAt:string|null;lastSuccessfulAt:string|null;lastReconciledAt:string|null;errorCode:string|null;retryAt:string|null;pendingManualKind?:'movie'|'episode'|null};
}
