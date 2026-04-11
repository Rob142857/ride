/* ── UI Store ──────────────────────────────────────────────────────── */
import { writable, derived } from 'svelte/store';
import type { AppView, ModalType, ToastMessage } from '$lib/types';

interface UIState {
	view: AppView;
	modal: ModalType;
	modalData: unknown;
	sideMenuOpen: boolean;
	toasts: ToastMessage[];
	landingSeen: boolean;
}

const initial: UIState = {
	view: 'map',
	modal: null,
	modalData: null,
	sideMenuOpen: false,
	toasts: [],
	landingSeen: localStorage.getItem('ride_landing_seen') === '1'
};

export const uiStore = writable<UIState>(initial);
export const uiState = uiStore;

export const currentView = derived(uiStore, ($u) => $u.view);
export const activeModal = derived(uiStore, ($u) => $u.modal);
export const modalData = derived(uiStore, ($u) => $u.modalData);
export const sideMenuOpen = derived(uiStore, ($u) => $u.sideMenuOpen);
export const toasts = derived(uiStore, ($u) => $u.toasts);
export const landingSeen = derived(uiStore, ($u) => $u.landingSeen);

let toastCounter = 0;

export function switchView(view: AppView): void {
	uiStore.update((s) => ({ ...s, view, sideMenuOpen: false }));
}

export function openModal(modal: ModalType, data?: unknown): void {
	uiStore.update((s) => ({ ...s, modal, modalData: data ?? null }));
}

export function closeModal(): void {
	uiStore.update((s) => ({ ...s, modal: null, modalData: null }));
}

export function toggleSideMenu(): void {
	uiStore.update((s) => ({ ...s, sideMenuOpen: !s.sideMenuOpen }));
}

export function closeSideMenu(): void {
	uiStore.update((s) => ({ ...s, sideMenuOpen: false }));
}

export function dismissLanding(): void {
	localStorage.setItem('ride_landing_seen', '1');
	uiStore.update((s) => ({ ...s, landingSeen: true }));
}

/* ── Toasts ──────────────────────────────────────────────────────── */
function addToast(text: string, type: ToastMessage['type'], duration = 3000): void {
	const id = ++toastCounter;
	uiStore.update((s) => ({ ...s, toasts: [...s.toasts, { id, text, type, duration }] }));
	setTimeout(() => {
		uiStore.update((s) => ({ ...s, toasts: s.toasts.filter((t) => t.id !== id) }));
	}, duration);
}

export function toastSuccess(text: string): void {
	addToast(text, 'success');
}

export function toastError(text: string): void {
	addToast(text, 'error', 5000);
}

export function toastInfo(text: string): void {
	addToast(text, 'info');
}
