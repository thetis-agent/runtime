# 19 Exa tools

`@thetis/exa` in `packages/exa` gives the model the Exa API as tools: web search, page contents, summaries, direct answers, research runs, and a direct call to any other endpoint. It is a `tool` package. It is not in `systemPackages` by default: a person installs it from the control panel, or an admin installs it for everyone. See [17-control-panel.md](17-control-panel.md).

## 1. Configuration

`config.packages["@thetis/exa"]`:

```json
{
  "apiKey": "${EXA_API_KEY}",
  "baseUrl": "https://api.exa.ai",
  "timeoutMs": 60000,
  "defaults": { "numResults": 8, "maxCharacters": 4000, "researchWaitSeconds": 240 }
}
```

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | none | Required. Put the key in `.env` as `EXA_API_KEY` and reference it. A tool call without a key fails with one sentence that names this field. |
| `baseUrl` | `https://api.exa.ai` | The API root. A proxy goes here. |
| `timeoutMs` | `60000` | Timeout of one HTTP request. |
| `defaults.numResults` | `8` | Results per search when the model does not say. |
| `defaults.maxCharacters` | none | Cap on page text the model gets back, in characters. |
| `defaults.researchWaitSeconds` | `240` | How long `exa_research` waits for a run before it returns the id. At most 540, under the fence request timeout. |

The kernel sends this object to the tools as `env.config` and to nothing else. See [09-configuration.md](09-configuration.md) section 4.

## 2. Tools

| Tool | Endpoint | What the model gets |
|---|---|---|
| `exa_search` | `POST /search` | Ranked results: title, URL, date, author, score. Highlights by default; `text`, `summary`, filters by domain, date, phrase, and category on request. |
| `exa_contents` | `POST /contents` | The pages at the given URLs: text by default, or highlights, a summary, links, and subpages. Pages that could not be fetched are listed with the reason. |
| `exa_summarize` | `POST /contents` with `summary` | One summary per URL, focused on a question or shaped by a JSON schema. |
| `exa_find_similar` | `POST /findSimilar` | Pages like the given URL, with the same content options as search. |
| `exa_answer` | `POST /answer` | A grounded answer and its sources. `model`, `systemPrompt`, and `outputSchema` pass through. |
| `exa_research` | `POST /agent/runs`, then `GET /agent/runs/<id>` | A research run. The tool polls every 5 seconds until the run ends or the wait is over, then returns the text, the structured output, and the sources. With `wait: false` it returns the id at once. |
| `exa_research_get` | `GET /agent/runs/<id>` | The state and result of a run. |
| `exa_research_cancel` | `POST /agent/runs/<id>/cancel` | Cancels a run. |
| `exa_research_list` | `GET /agent/runs` | Recent runs, with a cursor for the next page. |
| `exa_request` | any | Calls any path under `baseUrl` with the key and returns the JSON. This covers Websets and every endpoint the tools above do not name. |

Every tool returns plain text made for a model, not the raw JSON, except `exa_request`. A cost line closes each reply when the API reports one. Argument values are coerced: a number for `text` means text cut at that many characters; a string for `summary` is the question the summary answers.

## 3. Errors

A failed request becomes `error: Exa <status> on <method> <path>: <message>` for the model. The message is the API's `error`, `message`, or `error.message` field, with `error.detail` appended when the API sends one (it does for schema errors). A path that does not start with `/`, that has a host, or that contains `..` is refused before any request.

## 4. Code

| File | Content |
|---|---|
| `src/client.ts` | `createClient(config, fetch)`: base URL, key header, timeout, error sentences, `checkPath`. |
| `src/format.ts` | The text renderers: results, statuses, citations, answers, runs, lists. |
| `src/tools.ts` | `createTools({ fetch, sleep, now })`: one function per tool, argument coercion, the research poll loop. |
| `src/index.ts` | The exports the manifest names, bound to the global `fetch`. |
| `test/exa.test.ts` | Every tool against a recorded fake fetch; the error sentences; the path guard. One live case runs when `EXA_API_KEY` is set in the environment. |

The tools run inside the person's fence. The fence's network mode must allow outbound HTTPS: `egress` or `host`. See [03-fence.md](03-fence.md) section 3.2.
