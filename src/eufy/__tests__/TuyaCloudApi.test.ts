import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TuyaCloudApi } from '../TuyaCloudApi';

vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  randomBytes: (size: number) => Buffer.alloc(size),
  randomUUID: () => '11111111-1111-4111-8111-111111111111',
}));

/**
 * Known-answer vectors produced by running eufy-clean's own TuyaCloud.js steps
 * (node-rsa with RSA_NO_PADDING, HMAC request signing) on fixed inputs, so a
 * refactor that drifts from what Tuya accepts fails here, not at login.
 */
const TOKEN = {
  token: 'login-token',
  publicKey:
    '7868985680726115254204568393681843463470257411235919389617241872011641486642681906847531364059756267145909266607870467583032521540560995343408591729339119',
  exponent: '65537',
};
const EXPECTED_PASSWD =
  '297c396e515ce0f84eb2ede32c1d9a989124fe293d1105cc62afe696a320690bc333401afbb64dd1f55c6a753e26edff0bea145ec657cdf8822c38bea5944189';
const EXPECTED_TOKEN_REQUEST_SIGN = '42336f7e9cf349c361c93b0cd60edcea74536c3898c222f5797ceb0caec2a01b';

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

type Reply = { success: boolean; result?: unknown; errorCode?: string };

/**
 * Stubs fetch with Tuya replies chosen per request. Queued replies for an
 * action are consumed in order, the last one repeating.
 */
function stubTuya(replies: Record<string, Reply[]>, route: (url: URL) => Record<string, Reply[]> = () => replies) {
  const requests: URL[] = [];
  vi.stubGlobal('fetch', (input: string) => {
    const url = new URL(input);
    requests.push(url);
    const queue = route(url)[url.searchParams.get('a') ?? ''] ?? [{ success: false, errorCode: 'UNSTUBBED' }];
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    return Promise.resolve(new Response(JSON.stringify(reply)));
  });
  return requests;
}

const loginReplies = (mobileApiUrl = 'https://a1.tuyaeu.com'): Record<string, Reply[]> => ({
  'tuya.m.user.uid.token.create': [{ success: true, result: TOKEN }],
  'tuya.m.user.uid.password.login': [{ success: true, result: { sid: 'sid-1', domain: { mobileApiUrl } } }],
});

describe('TuyaCloudApi', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_789_600_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('signs requests and derives the login password exactly as the Eufy app does', async () => {
    const requests = stubTuya(loginReplies());

    await TuyaCloudApi.connect('user-1', log);

    const [tokenRequest, loginRequest] = requests;
    expect(tokenRequest?.searchParams.get('sign')).toBe(EXPECTED_TOKEN_REQUEST_SIGN);
    expect(JSON.parse(loginRequest?.searchParams.get('postData') ?? '{}')).toMatchObject({
      uid: 'eh-user-1',
      passwd: EXPECTED_PASSWD,
      token: 'login-token',
    });
  });

  it('falls back to the US region and uses the endpoint the login names', async () => {
    const eu = { 'tuya.m.user.uid.token.create': [{ success: false, errorCode: 'USER_NOT_EXISTS' }] };
    const us = {
      ...loginReplies('https://a2.tuyaus.com'),
      'tuya.m.location.list': [{ success: true, result: [] }],
      'tuya.m.my.shared.device.list': [{ success: true, result: [] }],
    };
    const requests = stubTuya({}, (url) => (url.host === 'a1.tuyaeu.com' ? eu : us));

    const api = await TuyaCloudApi.connect('user-1', log);
    await api.listDevices();

    expect(requests.at(-1)?.host).toBe('a2.tuyaus.com');
    expect(requests.at(-1)?.searchParams.get('sid')).toBe('sid-1');
  });

  it('logs in again once when the session has expired', async () => {
    const requests = stubTuya({
      ...loginReplies(),
      'tuya.m.device.dp.publish': [{ success: false, errorCode: 'USER_SESSION_LOSS' }, { success: true, result: true }],
    });
    const api = await TuyaCloudApi.connect('user-1', log);

    await api.sendDps('dev-1', { '152': 'AggG' });

    const actions = requests.map((url) => url.searchParams.get('a'));
    expect(actions.filter((action) => action === 'tuya.m.user.uid.password.login')).toHaveLength(2);
    expect(actions.filter((action) => action === 'tuya.m.device.dp.publish')).toHaveLength(2);
    expect(JSON.parse(requests.at(-1)?.searchParams.get('postData') ?? '{}')).toEqual({
      devId: 'dev-1',
      gwId: 'dev-1',
      dps: { '152': 'AggG' },
    });
  });

  it('does not retry errors other than an expired session', async () => {
    stubTuya({ ...loginReplies(), 'tuya.m.device.dp.publish': [{ success: false, errorCode: 'PERMISSION_DENIED' }] });
    const api = await TuyaCloudApi.connect('user-1', log);

    await expect(api.sendDps('dev-1', { '152': 'AggG' })).rejects.toThrow('PERMISSION_DENIED');
  });
});
