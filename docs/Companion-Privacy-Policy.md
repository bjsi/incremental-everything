# Incremental RemNote Companion: Privacy Policy

**Effective date: November 1, 2026**

This policy covers the Incremental RemNote Companion Chrome extension ("the extension"). It works with the Incremental RemNote plugin for [RemNote](https://www.remnote.com).

## In short

- The extension has no server of its own. Its developer never receives your data.
- What you extract goes to your own RemNote account, and a working copy stays in your browser.
- There are no analytics, no advertising and no tracking, and your data is not sold or shared with anyone.

## What the extension handles

**When you act on a page**, such as adding an extract, setting a read point or importing headings:

- the selected text, with any links, images and formatting in it;
- about 40 characters on either side of the selection, and its position in the page's text, used to find it again;
- the page's address and title;
- the page's headings, for the section of an extract, or all of them when you import headings;
- the priority you enter, if any.

**When you open the side panel:** the address and title of the current tab are sent to RemNote, which opens or creates that page's document in your account.

**While the panel is connected:** when a page loads, its address goes to the plugin running in your browser, to look up that page's saved highlights and read point.

**To show the bar and highlights,** the extension runs on the web pages you visit and searches their text for your saved highlights. That happens only inside your browser. Page content stays there unless you act on it as described above.

The extension does not read passwords or form fields, keep a record of the sites you visit, or send anything to its developer.

## Where it is stored

**In your browser** (Chrome's local extension storage, on this computer only):

- the highlights and read points of pages you have used it on, with their addresses;
- anything waiting to reach RemNote while the panel is closed;
- your **Set priority** preference.

**In your RemNote account:**

- your extracts and imported headings, as ordinary Rems;
- the addresses, highlight positions and read points of those pages, in the plugin's storage.

RemNote stores and syncs this data as it does your other notes, under RemNote's own terms and privacy policy. Its help center explains [the privacy of your notes](https://help.remnote.com/en/articles/7974260-privacy-of-your-notes).

The panel shows RemNote itself, signed in with your own account, and any other plugins you have installed in RemNote run there as usual. They are not part of this extension.

**Copy diagnostics** in the panel builds a technical log that stays in memory until the panel closes. It leaves only if you copy it and send it to someone.

## Who receives it

Only RemNote, on your behalf, as described above. The extension sends nothing to any other party.

## Permissions

| Permission | Why it is needed |
|---|---|
| Access to all websites | You may read on any site, so the bar, highlights and shortcuts have to work on all of them. It also reaches the plugin inside RemNote |
| Side panel | Shows RemNote beside the page |
| Tabs | Reads the current tab's address and title, and returns results to that tab |
| Storage | Keeps the browser copy described above |

## Removing your data

- **In your browser:** removing the extension deletes everything it stored there.
- **Extracts and headings:** delete the Rems in RemNote.
- **In the plugin's storage:** the addresses, positions and read points stay in your RemNote account after you remove the extension, and there is no button to erase them yet. Ask through the contact below if you need help, or delete your RemNote knowledge base or account, which removes them.

## Children

The extension is not directed at children under 13, and does not knowingly collect their data.

## Changes

Changes to this policy will be published on this page, with a new effective date.

## Contact

Questions about this policy are welcome in the project's [issue tracker](https://github.com/bjsi/incremental-everything/issues).
