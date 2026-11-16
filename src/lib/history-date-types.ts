export interface DateEditItemView {
 id:string; title:string; season:number|null; episode:number|null;
 oldWatchedAt:string|null; newWatchedAt:string; status:string; errorCode:string|null;
}
export interface DateEditView {
 id:string; scope:string; mode:string; timezone:string; status:string;
 errorCode:string|null; canCancel:boolean; canRetryAdd:boolean; total:number; completed:number; items:DateEditItemView[];
}
