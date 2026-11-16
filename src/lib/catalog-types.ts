export interface CatalogItem {kind:'movie'|'show';id:string;title:string;year:number|null;poster:string;}
export interface EpisodeOption {id:string;season:number;number:number;title:string;}
export interface ManualIntentView {id:string;kind:string;mediaId:string;title:string;year:number|null;season:number|null;episode:number|null;watchedAt:string;timezone:string;status:string;errorCode:string|null;poster:string;sent:boolean;}
