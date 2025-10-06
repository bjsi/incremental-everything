import { RNPlugin, RemId } from '@remnote/plugin-sdk';
import { allCardPriorityInfoKey } from './consts';
import { CardPriorityInfo, getCardPriority } from './cardPriority';

export async function updateCardPriorityInCache(plugin: RNPlugin, remId: RemId) {
  try {
    // DEBUG LOG: Announce that the function has been called.
    console.log(`CACHE-UPDATE: Function called for RemId: ${remId}`);
    
    const cache = (await plugin.storage.getSession<CardPriorityInfo[]>(allCardPriorityInfoKey)) || [];
    const rem = await plugin.rem.findOne(remId);
    if (!rem) {
      return;
    }
    
    const updatedInfo = await getCardPriority(plugin, rem);
    // DEBUG LOG: Show the fresh data fetched for the specific Rem.
    console.log('CACHE-UPDATE: Fetched latest info for Rem:', updatedInfo);

    const index = cache.findIndex(info => info.remId === remId);
    let newCache = [...cache]; // Create a copy for immutability

    if (index > -1) {
      // The Rem is already in the cache.
      if (updatedInfo) {
        // DEBUG LOG: Announce that we are updating an existing entry.
        console.log(`CACHE-UPDATE: Updating item at index ${index}.`);
        newCache[index] = updatedInfo;
      } else {
        // DEBUG LOG: Announce that we are removing an entry.
        console.log(`CACHE-UPDATE: Removing item from index ${index}.`);
        newCache.splice(index, 1);
      }
    } else if (updatedInfo) {
      // DEBUG LOG: Announce that we are adding a new entry.
      console.log(`CACHE-UPDATE: No existing item found. Adding new item to cache.`);
      newCache.push(updatedInfo);
    }

    // DEBUG LOG: Show the final state of the cache before it's saved.
    console.log('CACHE-UPDATE: Saving new cache to session storage.', newCache);
    await plugin.storage.setSession(allCardPriorityInfoKey, newCache);

  } catch(e) {
    console.error("Error updating card priority cache for Rem:", remId, e);
  }
}