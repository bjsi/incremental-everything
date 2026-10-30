/**
 * Tests for settings saved per knowledge base. Run with `npm test`.
 */
import './sdk_test_env';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fsrsRequestedRetentionId, fsrsWeightsId, ieSettingsValuesKey, multiplierId } from './consts';
import { IE_SETTINGS_DEFAULTS, getIESetting, kbSettingsKey, resetKbScopeMemo, setIESetting } from './settings';

const MAIN = 'mainKb';
const OTHER = 'otherKb';
const WEIGHTS = '1, 2, 3';

/** Synced storage is shared by the account's KBs, so the store outlives a KB switch. */
function account(initialBlob: object = {}) {
  const store = new Map<string, any>([[ieSettingsValuesKey, initialBlob]]);
  const pluginIn = (kbId: string | null): any => {
    resetKbScopeMemo();
    return {
      store,
      storage: {
        getSynced: async (key: string) => store.get(key),
        setSynced: async (key: string, value: any) => void store.set(key, value),
      },
      kb: {
        getCurrentKnowledgeBaseData: async () => {
          if (!kbId) throw new Error('unavailable');
          return { _id: kbId };
        },
        isPrimaryKnowledgeBase: async () => kbId === MAIN,
      },
    };
  };
  return { store, pluginIn };
}

describe('settings saved per knowledge base', () => {
  beforeEach(() => resetKbScopeMemo());

  it('keeps an edit in the KB where it was made', async () => {
    const { pluginIn } = account();
    await setIESetting(pluginIn(OTHER), fsrsWeightsId, WEIGHTS);
    assert.equal(await getIESetting(pluginIn(OTHER), fsrsWeightsId), WEIGHTS);
    assert.equal(await getIESetting(pluginIn(MAIN), fsrsWeightsId), '');
    assert.equal(await getIESetting(pluginIn('thirdKb'), fsrsWeightsId), '');
  });

  it('lets each KB hold its own value', async () => {
    const { pluginIn } = account();
    await setIESetting(pluginIn(MAIN), fsrsRequestedRetentionId, 85);
    await setIESetting(pluginIn(OTHER), fsrsRequestedRetentionId, 95);
    assert.equal(await getIESetting(pluginIn(MAIN), fsrsRequestedRetentionId), 85);
    assert.equal(await getIESetting(pluginIn(OTHER), fsrsRequestedRetentionId), 95);
  });

  it('gives the old shared value to the main KB and not to a secondary one', async () => {
    const { pluginIn } = account({ [fsrsWeightsId]: WEIGHTS });
    assert.equal(await getIESetting(pluginIn(MAIN), fsrsWeightsId), WEIGHTS);
    assert.equal(await getIESetting(pluginIn(OTHER), fsrsWeightsId), '');
  });

  it('prefers the KB value over the old shared one', async () => {
    const { pluginIn } = account({ [fsrsWeightsId]: WEIGHTS });
    await setIESetting(pluginIn(MAIN), fsrsWeightsId, '4, 5, 6');
    assert.equal(await getIESetting(pluginIn(MAIN), fsrsWeightsId), '4, 5, 6');
  });

  it('does not bring the old shared value back after a reset on the main KB', async () => {
    const { store, pluginIn } = account({ [fsrsWeightsId]: WEIGHTS, [multiplierId]: 2 });
    await setIESetting(pluginIn(MAIN), fsrsWeightsId, IE_SETTINGS_DEFAULTS[fsrsWeightsId]);
    assert.equal(await getIESetting(pluginIn(MAIN), fsrsWeightsId), '');
    assert.equal(store.get(ieSettingsValuesKey)[fsrsWeightsId], undefined);
    assert.equal(store.get(ieSettingsValuesKey)[multiplierId], 2);
  });

  it('leaves the old shared value alone when a secondary KB saves its own', async () => {
    const { store, pluginIn } = account({ [fsrsWeightsId]: WEIGHTS });
    await setIESetting(pluginIn(OTHER), fsrsWeightsId, '4, 5, 6');
    assert.equal(store.get(ieSettingsValuesKey)[fsrsWeightsId], WEIGHTS);
    assert.equal(store.get(kbSettingsKey(OTHER))[fsrsWeightsId], '4, 5, 6');
  });

  it('keeps other settings shared by all KBs', async () => {
    const { store, pluginIn } = account();
    await setIESetting(pluginIn(OTHER), multiplierId, 3);
    assert.equal(await getIESetting(pluginIn(MAIN), multiplierId), 3);
    assert.equal(store.get(ieSettingsValuesKey)[multiplierId], 3);
  });

  it('falls back to the shared value when the KB can not be read', async () => {
    const { pluginIn } = account({ [fsrsWeightsId]: WEIGHTS });
    assert.equal(await getIESetting(pluginIn(null), fsrsWeightsId), WEIGHTS);
  });
});
