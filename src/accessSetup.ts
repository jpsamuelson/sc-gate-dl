import { readFile } from 'node:fs/promises';
import { type AccessResult, checkSoundcloudAccess } from './accessCheck';
import { setEnvValues } from './envFile';

export interface EnsureSoundcloudInput {
	envPath: string;
	clientId: string;
	oauthToken: string;
	refreshToken: string;
	now: () => number;
	interactive: boolean;
	log: (line: string) => void;
	fetchMe: (token: string) => Promise<{ ok: boolean; status: number }>;
	/** Exchanges the refresh token. SoundCloud rotates it on every call. */
	refresh: () => Promise<{ accessToken: string; refreshToken: string }>;
}

/**
 * Check the SoundCloud login at startup and renew it when that is possible.
 * A renewed pair is written to `.env` at once, because SoundCloud rotates the
 * refresh token and the old one stops working. Never throws and never logs a
 * token value.
 */
export async function ensureSoundcloudAccess(
	input: EnsureSoundcloudInput,
): Promise<AccessResult> {
	let renewedPair: { accessToken: string; refreshToken: string } | null = null;
	const result = await checkSoundcloudAccess({
		clientId: input.clientId,
		oauthToken: input.oauthToken,
		refreshToken: input.refreshToken,
		now: input.now,
		fetchMe: input.fetchMe,
		refresh: async () => {
			renewedPair = await input.refresh();
			return renewedPair.accessToken;
		},
	});

	if (renewedPair) {
		const pair = renewedPair as { accessToken: string; refreshToken: string };
		try {
			await setEnvValues(input.envPath, {
				SC_OAUTH_TOKEN: pair.accessToken,
				SC_REFRESH_TOKEN: pair.refreshToken,
			});
		} catch {
			input.log(
				'SoundCloud login was renewed but could not be saved to .env. It is used for this run only; log in again if the next start fails.',
			);
		}
	}
	if (result.action) input.log(result.action);
	return result;
}

export interface SoundcloudCookieStatus {
	state: 'valid' | 'missing' | 'invalid' | 'unverifiable';
}

/**
 * Browser gates use `soundcloud-cookies.json`, not the token in `.env`. The two
 * can drift apart, so the cookie's own `oauth_token` is checked against SoundCloud
 * as well. A network error or a rate limit is `unverifiable`, never `invalid`.
 */
export async function checkSoundcloudCookies(
	path = 'soundcloud-cookies.json',
	fetchMe: (token: string) => Promise<{ ok: boolean; status: number }>,
): Promise<SoundcloudCookieStatus> {
	let token: string | undefined;
	try {
		const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
		const cookie = Array.isArray(parsed)
			? (parsed as { name?: unknown; value?: unknown }[]).find(
					(c) => c?.name === 'oauth_token',
				)
			: undefined;
		if (typeof cookie?.value === 'string' && cookie.value) {
			try {
				token = decodeURIComponent(cookie.value);
			} catch {
				token = cookie.value;
			}
		}
	} catch {
		return { state: 'missing' };
	}
	if (!token) return { state: 'missing' };
	try {
		const response = await fetchMe(token);
		if (response.ok) return { state: 'valid' };
		return {
			state:
				response.status === 401 || response.status === 403
					? 'invalid'
					: 'unverifiable',
		};
	} catch {
		return { state: 'unverifiable' };
	}
}

/**
 * The token alone is not enough: browser gates run on the saved cookies. Only a
 * valid token is downgraded; a token problem is reported as it is.
 */
export function combineSoundcloudAccess(
	token: AccessResult,
	cookies: SoundcloudCookieStatus,
): AccessResult {
	if (token.state !== 'valid') return token;
	if (cookies.state === 'invalid' || cookies.state === 'missing') {
		return {
			state: cookies.state,
			renewed: token.renewed,
			action:
				'The saved SoundCloud browser login is missing or no longer accepted. Run `bun start --login` and log in to SoundCloud again.',
		};
	}
	return token;
}

export interface SpotifyCookieStatus {
	state: 'present' | 'missing' | 'invalid' | 'expired';
	/** Spotify gates fail mid-download without a login, so it is always checked. */
	required: true;
}

/**
 * Offline check of the saved Spotify login: the file must parse and hold an
 * `sp_dc` login cookie that has not passed its expiry. It does not call Spotify,
 * so a cookie revoked server-side is only found when a gate fails.
 */
export async function checkSpotifyCookies(
	path = 'spotify-cookies.json',
	now: () => number = Date.now,
): Promise<SpotifyCookieStatus> {
	let text: string;
	try {
		text = await readFile(path, 'utf8');
	} catch {
		return { state: 'missing', required: true };
	}
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!Array.isArray(parsed) || parsed.length === 0) {
			return { state: 'invalid', required: true };
		}
		const login = (
			parsed as { name?: unknown; expirationDate?: unknown }[]
		).find((cookie) => cookie?.name === 'sp_dc');
		if (!login) return { state: 'invalid', required: true };
		const expires = login.expirationDate;
		if (typeof expires === 'number' && expires * 1000 <= now()) {
			return { state: 'expired', required: true };
		}
		return { state: 'present', required: true };
	} catch {
		return { state: 'invalid', required: true };
	}
}
