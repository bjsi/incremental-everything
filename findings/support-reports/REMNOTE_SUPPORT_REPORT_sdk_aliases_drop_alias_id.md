# Bug report: the plugin SDK drops `aliasId` from `getAliases()` and `getOrCreateAliasWithText()`

**From:** Hugo Marins, *Incremental RemNote* plugin (`incremental-everything`)
**Checked against:** RemNote desktop 1.30.2-beta (macOS), `@remnote/plugin-sdk` 0.0.46 (the latest on npm)
**Date:** 2026-11-14

---

## Summary

Since aliases stopped being Rems, plugins can no longer find out which alias a Rem reference points at, and can't write a reference to a given alias.

The plugin bridge still sends the right data: `getAliases` answers with `{aliasId, text}`. But the SDK wraps each answer as a Rem object, and a Rem object only keeps `_id`, `text`, `backText` and a few other fields. So `aliasId` is thrown away, and each alias reaches the plugin with `_id: undefined`. `getOrCreateAliasWithText()` loses the id in the same way.

## What users see

A reference to an alias is stored as `{i: 'q', _id: <owner>, aliasId: <alias>}` and renders the alias text. Any plugin that turns rich text into plain text has to look that alias up, and today it can't:

- **Text-to-speech:** a note says "*[sea margin]* becomes useless…", where `sea margin` is an alias of the Rem *Service power margin*. Our Read Aloud feature dropped the reference completely and read "…than previously expected. becomes useless…". The old way to read the alias, `plugin.rem.findOne(aliasId)`, now returns `undefined`.
- **Inserting references:** our reference picker finds Rems by their aliases, as `[[` does. To insert a reference that shows the matched alias, it needs that alias's id. Neither `getAliases()` nor `getOrCreateAliasWithText()` returns one any more, so the inserted reference showed the Rem's main name instead of the alias the user picked.

## Steps to reproduce

1. Create a Rem *Service power margin* and give it two aliases: *service power* and *sea margin*.
2. In another Rem, type `[[sea margin` and pick the alias. The stored element is `{i:'q', _id:'<owner id>', aliasId:'<alias id>'}`.
3. In a plugin:

   ```ts
   const owner = await plugin.rem.findOne('<owner id>');

   const aliases = await owner.getAliases();
   // [{ _id: undefined, text: ['service power'], … }, { _id: undefined, text: ['sea margin'], … }]
   // There's no way to tell which one '<alias id>' is.

   await plugin.rem.findOne('<alias id>');
   // undefined: the alias isn't a Rem any more (its id is listed in missing_ids_quanta).

   const alias = await owner.getOrCreateAliasWithText(['sea margin']);
   // { _id: undefined, text: ['sea margin'], … }: the id is lost here too.
   ```

**Expected:** each alias comes with its `aliasId`, so a plugin can match it against the `aliasId` of a reference element and write that id into new references.

## Cause

Host side (RemNote 1.30.2-beta), the bridge handlers already send the id:

```js
name: "getAliases"  → (a?.getAliases() || []).map(n => ({ aliasId: n.aliasId, text: strToRichText(n.alias) }))
name: "getOrCreateAliasWithText" → … return o ? { aliasId: o.aliasId, text: strToRichText(o.alias) } : void 0
```

SDK side (`@remnote/plugin-sdk` 0.0.46, `dist/index.js`), both calls go through the generic Rem wrappers:

```js
getAliases               = () => this.callAndReturnManyRem("getAliases")
getOrCreateAliasWithText = n  => this.callAndReturnRem("getOrCreateAliasWithText", { aliasText: n })
```

These wrappers build a `RemObject`, whose constructor copies only `_id`, `parent`, `children`, `type`, `text`, `backText`, `u`, `o` and `createdAt`. An alias answer has no `_id`, and its `aliasId` isn't one of the copied fields, so the id is lost. The typings still say `getAliases: () => Promise<RemObject[]>`, which promises Rems that no longer exist.

## Workaround we ship

`RemObject.call` is a public property. Calling the bridge through it returns the answer without the wrapper:

```ts
const raw = await (owner as any).call('getAliases');                      // [{ aliasId, text }]
const one = await (owner as any).call('getOrCreateAliasWithText', { aliasText }); // { aliasId, text }
```

This works, but it depends on SDK internals and could break with any SDK update.

## Suggested fix

- Return the bridge's answer as it comes, with a type of its own, for example:

  ```ts
  interface RemAlias { aliasId: string; text: RichTextInterface }
  getAliases(): Promise<RemAlias[]>;
  getOrCreateAliasWithText(aliasText: RichTextInterface): Promise<RemAlias | undefined>;
  ```

  If changing the return type is a concern, a new method such as `getAliasesWithIds()` would do. Keeping the current wrapper but setting `_id = aliasId` would also unblock plugins.
- Document on `RichTextElementRemInterface.aliasId` that the alias isn't a Rem: `findOne(aliasId)` returns nothing, and its text is read from the owner's aliases.

Thank you!
