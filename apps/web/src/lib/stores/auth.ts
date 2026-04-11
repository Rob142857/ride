/* ── Auth Store ─────────────────────────────────────────────────────── */
import { writable, derived } from 'svelte/store';
import type { User, AuthStatus } from '$lib/types';
import { auth } from '$lib/api';

interface AuthState {
	user: User | null;
	status: AuthStatus;
}

const initial: AuthState = { user: null, status: 'unknown' };

export const authStore = writable<AuthState>(initial);

export const isAuthenticated = derived(authStore, ($a) => $a.status === 'authenticated');
export const isChecking = derived(authStore, ($a) => $a.status === 'unknown' || $a.status === 'checking');
export const currentUser = derived(authStore, ($a) => $a.user);

export async function checkAuth(): Promise<boolean> {
	authStore.update((s) => ({ ...s, status: 'checking' }));
	const res = await auth.me();
	if (res.ok && res.data?.user) {
		authStore.set({ user: res.data.user as User, status: 'authenticated' });
		return true;
	}
	authStore.set({ user: null, status: 'unauthenticated' });
	return false;
}

export function login(provider: string): void {
	auth.login(provider);
}

export async function logout(): Promise<void> {
	await auth.logout();
	authStore.set({ user: null, status: 'unauthenticated' });
}

export function setAuthError(): void {
	authStore.update((s) => ({ ...s, status: 'error' }));
}
