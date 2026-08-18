#!/root/.bun/bin/bun

const response = await fetch("http://127.0.0.1:8080/health", {
  signal: AbortSignal.timeout(5_000),
});
const payload: any = await response.json().catch(() => null);
if (!response.ok || payload?.ok !== true) {
  console.error(JSON.stringify({ ok: false, status: response.status, payload }));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, status: response.status }));
