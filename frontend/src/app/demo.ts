import {useQuery} from '@tanstack/react-query'
import {api} from '../lib/api'

export type DemoAccount={role:'MANAGER'|'STAFF'|'VIEWER';email:string;password:string}
export type DemoInfo={enabled:boolean;accountChangesAllowed?:boolean;notifications?:string;accounts?:DemoAccount[];limits?:{
  csvRows:number;csvBytes:number;evidenceBytes:number;exportBytes:number;storageBytes:number;transferBytes:number;databaseBytes:number;cooldownSeconds:number
}}
export function useDemoInfo() {
  const query=useQuery({queryKey:['demo-info'],queryFn:()=>api<DemoInfo>('/demo-info'),staleTime:300_000,retry:1,retryDelay:2000})
  return {...query.data,enabled:query.data?.enabled===true,loading:query.isPending}
}
