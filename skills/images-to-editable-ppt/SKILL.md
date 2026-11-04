---
name: images-to-editable-ppt
description: Batch-convert images (slide screenshots, exported slide PNGs, posters, infographics, scanned pages) into an editable PowerPoint (.pptx) deck with EditablePPT, one slide per image, with real editable text boxes over separated image layers. Use when the user wants to turn pictures or a folder of images into editable PPT/PowerPoint slides, make image slides editable, or rebuild slides from screenshots. Needs the EditablePPT MCP tools from this plugin.
license: MIT
compatibility: Requires Node.js 18+ for the bundled stdio MCP server, network access to https://editableppt.com, and a browser for the one-time sign-in. Converting spends EditablePPT credits.
metadata:
  author: EditablePPT
  version: "1.0.0"
---

# Images to editable PowerPoint

The `editableppt` MCP server in this plugin turns PNG/JPG images into an
editable `.pptx`: each image becomes one slide whose text is real, editable
text (matched fonts, sizes and colors) placed over the cleaned image layers.

## Tools

| Tool | Use |
| --- | --- |
| `editableppt_sign_in` | One-time browser sign-in. Call again after the user approves. |
| `editableppt_account` | Account, credit balance, credits per image for each quality. |
| `editableppt_convert_images` | Upload images, wait, write the `.pptx`. **Spends credits.** |
| `editableppt_wait_for_job` | Keep waiting on a job that was still running; writes the `.pptx`. |
| `editableppt_list_jobs` | Recent local jobs and their output files. |
| `editableppt_cancel_job` | Cancel unfinished conversions (refunded). |
| `editableppt_sign_out` | Sign out and revoke the plugin's key. |

## Workflow

1. **Collect the images.** Get absolute paths of the files or folders, in slide
   order. A folder is read in natural name order (`2.png` before `10.png`).
   Only PNG and JPG up to 20 MB and 25 megapixels are accepted; convert other
   formats (WebP, HEIC, GIF, BMP) to PNG first with a local tool. For a PDF,
   render its pages to PNG first.
2. **Sign in if needed.** Call `editableppt_account`. If it says you are not
   signed in, call `editableppt_sign_in`. It opens an authorization page in the
   user's browser and also returns the URL: show the URL to the user, ask them
   to sign in and click **Authorize**, then call `editableppt_sign_in` again
   until it reports the account. Never ask the user for a password or API key.
3. **Confirm the cost.** Tell the user the number of images, the quality, the
   credits it will spend (`images × credits per image` from
   `editableppt_account`) and their balance, and get a clear yes before
   converting. Choose the quality with the user:
   - `standard` (default): editable text over the image layers. Cheaper and
     faster; right for most slides and screenshots.
   - `layered`: also separates photos, icons/decorations, cards/buttons and the
     background into depth layers. Use when the user wants to move or restyle
     the graphics, not just edit the text. `refine: true` additionally rebuilds
     cards and buttons as native shapes.
4. **Convert.** Call `editableppt_convert_images` with `images`, `quality`, and
   optionally `title` and `output` (a `.pptx` path or a folder). By default the
   deck is written next to the first image. More than 20 images produce several
   files of up to 20 slides each (`… (part 1).pptx`, `… (part 2).pptx`).
5. **If it is still running**, the result contains a `job_id`. Call
   `editableppt_wait_for_job` with it until the result lists the `.pptx` files.
   Conversions continue on the server in the meantime; don't start the same
   images again, that charges again.
6. **Report** the output paths and any images that failed. Failed or canceled
   conversions are refunded automatically; offer to retry only those images.

## Rules

- Converting spends the user's credits: always confirm before
  `editableppt_convert_images`, and never re-run a job just to "check" it —
  use `editableppt_wait_for_job` or `editableppt_list_jobs`.
- Don't print or store the sign-in token; the server keeps it in the plugin's
  private data directory.
- If the balance is too low, tell the user how many credits are missing and
  point them to https://editableppt.com/pricing instead of converting a subset
  without asking.

See [references/troubleshooting.md](references/troubleshooting.md) for error
messages and limits.
