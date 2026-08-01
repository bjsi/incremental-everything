# Contributing to this Documentation

We welcome and encourage community contributions to this documentation! If you find something missing, unclear, or out of date, please help us improve it.

**Note:** This manual used to be a GitHub Wiki. Since August 2026 it is a [MkDocs Material](https://squidfunk.github.io/mkdocs-material/) site whose source lives in the plugin's own repository, under the `docs/` folder. That means the normal Fork → edit → Pull Request workflow now works properly — which it never did for GitHub Wikis.

## How to Contribute

### 1. Suggesting Changes (The Easiest Way)
If you don't feel comfortable writing the Markdown yourself, or simply want to report a missing topic, please open an Issue in the main project repository. Explain what is missing, unclear, or out of date, and we will take care of it!

### 2. Editing a Page Directly on GitHub
Every page of this site corresponds to one `.md` file in the `docs/` folder of the repository. To fix a typo or rewrite a paragraph:

1. Open the corresponding file under `docs/` on GitHub.
2. Click the ✏️ **Edit** button — GitHub will fork the repository for you automatically.
3. Make your changes and click **Propose changes**, then **Create pull request**, briefly explaining what you changed.

That's it. Once the pull request is merged, the site rebuilds and publishes itself automatically.

### 3. Local Git Workflow
For larger changes, clone the repository, edit the files under `docs/`, and open a pull request as usual. If you want to preview the site as you write:

```bash
pip install mkdocs-material
mkdocs serve      # live preview at http://127.0.0.1:8000
```

Creating a new `.md` file is only half of adding a page: it must also be listed in the `nav:` section of `mkdocs.yml`, or it will build and be searchable but appear nowhere in the navigation sidebar. `nav:` also determines the order and grouping of pages.

## General Guidelines

When writing or editing pages, please follow these general best practices:

* **Keep it Clear and Concise:** Write simple sentences. Aim for clarity and avoid jargon where possible.
* **Use Formatting:** Use bolding for UI elements (e.g., click the **Dismiss** button), and use standard Markdown headers (`##`) to organize content.
* **Link between pages:** Link to the Markdown file, not the published URL — e.g. `[Utilities](Utilities.md)` or `[the Shield](Prioritization-&-Sorting.md#weighted-shield)`. MkDocs converts these to the right links and warns if a target no longer exists.
* **Screenshots:** Explaining complex visual tasks is usually easier with a screenshot or a short GIF. Put image files in `docs/assets/` and reference them relatively, e.g. `![Alt text](assets/my-screenshot.png)`. If you'd rather not deal with files, just attach the image to your GitHub Issue and we will add it.

Thank you for helping us make the Incremental Everything documentation better for everyone!
