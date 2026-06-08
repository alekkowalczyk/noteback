# Noteback — Privacy Policy

_Last updated: 2026-06-08_

Noteback is a browser extension (with a companion CLI and agent skill) for
annotating HTML documents: you highlight text, attach comments, and export the
result as Markdown or as a self-contained HTML "feedback canvas".

## Short version

**Noteback does not collect, transmit, sell, or share any of your data.**
Everything you create stays on your device. There are no servers, no accounts,
no analytics, and no third-party services.

## What Noteback stores, and where

Noteback stores only the annotations you create — highlighted passages, your
comments, and version-history snapshots of the document — so they persist while
you work:

- **Extension mode:** in your browser's local extension storage
  (`chrome.storage.local`) on your computer.
- **Saved "feedback canvas" files:** embedded inside the HTML file you save and,
  for local files, in that page's `localStorage` on your computer.

This data never leaves your device. Noteback makes no network requests to send,
back up, or process your content.

## Permissions and why they are used

- **storage** — save your highlights, comments, and history locally.
- **activeTab** and **scripting** — when you click the Noteback toolbar button on
  a page where it is not already active, mount the annotation overlay into that
  current tab. Used only in response to your click.
- **downloads** — save the feedback canvas or a clean HTML copy to your computer
  when you choose "Save".
- **Host access** to `file:///*`, `http://localhost/*`, and `http://127.0.0.1/*`
  — so Noteback can run on local HTML files you open and on documents you serve
  from a local development server. No other sites are accessed.

## No remote code

All of Noteback's code ships inside the extension package. It does not download
or execute any remote or third-party code.

## Your control over your data

Your data lives on your device. You can remove it at any time by deleting
individual comments in Noteback, clearing the browser's storage for the
extension, deleting a saved canvas file, or uninstalling the extension.

## Children's privacy

Noteback is a general-purpose productivity tool, is not directed at children, and
collects no personal information from anyone.

## Changes

If this policy changes, the updated version will be posted at this URL with a new
"Last updated" date.

## Contact

Questions or concerns: please open an issue at
https://github.com/alekkowalczyk/noteback/issues
