<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.png';
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { updated } from '$app/state';
	import BottomNav from '$lib/components/BottomNav.svelte';
	import CaptureSheet from '$lib/components/CaptureSheet.svelte';
	import ChatSheet from '$lib/components/ChatSheet.svelte';
	import { captureOpen } from '$lib/stores/capture';

	let { children, data } = $props();

	// Inside the iOS app's WebView, nudge the home-screen widget to reload after
	// any food-log change (create / edit / delete — all hit /api/log) so it never
	// shows stale numbers. The reload re-fetches /api/today, which updates the
	// deficit too. No-op in a normal browser (the message handler doesn't exist).
	onMount(() => {
		// Native → web soft refresh, called by the iOS wrapper after each foreground
		// HealthKit sync so freshly-pushed metrics (today's water, HR, …) show up. It
		// re-runs the load functions in place, so an open capture sheet / live barcode
		// scan survives — the hard webView.reload() this replaced used to kill them
		// mid-flow. Returns true so the native side knows the hook exists.
		(window as unknown as { __hmRefresh?: () => boolean }).__hmRefresh = () => {
			// invalidateAll() re-runs the LOAD functions but never re-fetches the app's JS, so a
			// deploy while this WebView stayed open leaves OLD components rendering NEW data —
			// silently wrong UI with right numbers (a workout showed "trusted" instead of its
			// "our est." label for exactly this reason). updated.check() asks the server whether
			// the build changed; if it did, only a hard reload can pick up the new components.
			// Fire-and-forget so `return true` stays synchronous — the native side reads it to
			// confirm the hook exists, and a Promise there would not survive evaluateJavaScript.
			updated.check().then((isNewBuild) => (isNewBuild ? location.reload() : invalidateAll()));
			return true;
		};

		const widget = (
			window as unknown as {
				webkit?: { messageHandlers?: { widget?: { postMessage(m: string): void } } };
			}
		).webkit?.messageHandlers?.widget;
		if (!widget) return;

		const orig = window.fetch;
		window.fetch = async (input, init) => {
			const res = await orig(input, init);
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			const method = (
				init?.method ?? (input instanceof Request ? input.method : 'GET')
			).toUpperCase();
			if (
				res.ok &&
				method !== 'GET' &&
				(url.includes('/api/log') ||
					url.includes('/api/planned') ||
					url.includes('/api/chat/confirm'))
			)
				widget.postMessage('reload');
			return res;
		};
	});
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<!-- Pad below the iOS status bar / Dynamic Island in standalone PWA mode, and
     above the fixed bottom nav, so page content never hides behind either.
     env() resolves to 0 in a normal browser, so the insets are no-ops there. -->
<div
	style="padding-top: env(safe-area-inset-top); padding-bottom: calc(4.5rem + env(safe-area-inset-bottom));"
>
	{@render children()}
</div>

<BottomNav unread={data.unreadChats} />
<CaptureSheet bind:open={$captureOpen} />
<ChatSheet />
