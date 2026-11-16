/** Explicit stock-native observations. Unknown methods cannot bypass a custody hold. */
const observations=new Set(['initialize','initialized','thread/read','thread/list','thread/loaded/list',
  'thread/turns/list','thread/items/list','thread/search','thread/searchOccurrences','thread/queue/list',
  'thread/goal/get','thread/backgroundTerminals/list','model/list','account/read','account/rateLimits/read',
  'config/read','configRequirements/read','skills/list','app/list','experimentalFeature/list','mcpServerStatus/list']);

export function isCodexNativeObservation(method:string):boolean{return observations.has(method);}
