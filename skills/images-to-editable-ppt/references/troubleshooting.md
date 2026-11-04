# Troubleshooting

## Limits

| Limit | Value |
| --- | --- |
| Formats | PNG, JPG/JPEG |
| File size | 20 MB per image |
| Image size | 25 megapixels |
| Images per job | 100 |
| Slides per `.pptx` | 20 (larger jobs are split into parts) |

## Messages

| Message | What to do |
| --- | --- |
| `Not signed in to EditablePPT` | Run the sign-in step (`editableppt_sign_in`). |
| `The EditablePPT sign-in expired or was revoked` | The key was revoked (signed out elsewhere or deleted). Sign in again. |
| `Not enough credits: …` | Nothing was charged. Tell the user the shortfall; they can top up at https://editableppt.com/pricing. |
| `Not enough credits` on some images of a job | Images uploaded before the balance ran out still convert and are exported; the rest are listed as skipped. |
| `Only PNG and JPG images are supported` | Convert the file to PNG locally, then retry. |
| `Use a PNG or JPG image with at most 25 megapixels` | Downscale the image (e.g. to 4K width) and retry that image. |
| `Could not reach https://editableppt.com` | Network problem. Retry; for a running job use `editableppt_wait_for_job`. |
| A conversion `failed` | It is refunded automatically. Retry just that image in a new job. |
| Still running after `wait_seconds` | Normal for large or layered jobs. Call `editableppt_wait_for_job` with the `job_id`. |

## Where things are stored

The MCP server keeps its sign-in key, the pending sign-in request and the job
records in the client-provided `PLUGIN_DATA` directory (falls back to
`~/.editableppt-agent`). Files are created with owner-only permissions.
Signing out (`editableppt_sign_out`) revokes the key on the server and deletes
it locally.
