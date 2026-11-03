let transitioning = false;
export function isAccountTransitioning(): boolean { return transitioning; }
export function assertAccountReady(): void {
  if (transitioning) throw new Error('账号正在切换，请等待后台核验完成后重发指令。');
}
export async function withAccountTransition<T>(operation: () => Promise<T>): Promise<T> {
  assertAccountReady();
  transitioning = true;
  try { return await operation(); } finally { transitioning = false; }
}
