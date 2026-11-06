/** Keep runner-only home references out of local provider environments. */
export function providerAccountHomeForPlacement(runnerTarget:string|null,account:string,localHome:string):string{
  return runnerTarget?`runner-account:${account}`:localHome;
}
