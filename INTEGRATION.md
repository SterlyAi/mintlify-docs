
---

```markdown
# Filecheck — Plugin Integration Reference

> This document is for an AI coding agent (or human developer) building a
> Filecheck plugin for WordPress, Shopify, OpenCart, PrestaShop, or any
> other CMS / e-commerce platform. No access to the Filecheck monorepo is
> required.

---

## 1. What Filecheck is

Filecheck is a **file validation / preflight service**. It sits in front of
an "Upload" button and decides — by configurable rule — whether a file is fit
for purpose, and when possible auto-fixes it.

The integration pattern is always the same: the merchant configures a
**Workflow** in the Filecheck admin (which files are accepted, what validation
runs, what to do on failure). The plugin drops a widget onto the product page
that runs the customer's file through that Workflow before allowing them to
proceed.

---

## 2. Keys

| Key | Prefix | Use |
| --- | --- | --- |
| **Publishable key** | `pk_live_…` / `pk_test_…` | Embedded in page JS. Safe to ship in public code. |
| **Secret key** | `sk_live_…` / `sk_test_…` | **Server-side only.** Never put in browser code. |

Optional: **`agentId`** (`agt_…`) — scopes the element to a specific
sub-tenant / store (useful when one Filecheck account powers multiple stores).

---

## 3. The Filecheck Element

Load via CDN using the **pk-specific URL** (preferred for plugins — embeds your
tenant config so no separate config fetch is needed, cached by CloudFront per key):

```html
<script src="https://cdn.filecheck.io/element/{pk}/filecheck.js" async></script>
```

Replace `{pk}` with the merchant's publishable key, e.g.
`pk_live_abc123`. The generic fallback `https://cdn.filecheck.io/element/v1/filecheck.js`
still works but does not embed tenant config.

Either URL attaches `window.Filecheck` once loaded.

### 3.1 Full public API

```js
const fc = Filecheck('pk_live_...', {
    agentId?:   'agt_...',  // optional sub-tenant scope
    iframeSrc?: '...',      // staging/dev override only
});

const intake = fc.elements.create('intake', {
    workflowId?:   'wf_...',  // required unless resuming with jobId
    jobId?:        'job_...', // resume an existing job (workflowId ignored)
    locale?:       'en-US',
    presentation?: 'inline',  // 'inline' (default) | 'dialog'
    connector?:    { … },     // map file facts → product-page controls (see §6)
    connectorId?:  'cntr_...',// server-side connector resolution (see §6.3)
    onConnectorApply?: (results) => {}, // per-binding apply report (debug)
    ui?: {
        title?:       string,
        subtitle?:    string,
        theme?:       'light' | 'dark' | 'system',
        accent?:      string,  // hex e.g. '#6366f1'
        layout?:      'inline' | 'modal' | 'drawer' | 'compact',
        showHeader?:  boolean,
        showHelp?:    boolean,
        helpText?:    string,
        submitLabel?: string,
        autoSubmit?:  boolean,
        branding?:    'domain' | 'none' | 'custom',
    },
});

intake.mount('#fc-slot');           // or .mount(htmlElement)

intake.on('ready',   ({ ui })            => { /* iframe ready; ui = resolved IntakeUi */ });
intake.on('status',  (payload)           => { /* IntakeStatusPayload — see §4 */ });
intake.on('facts',   (facts)             => { /* IntakeFacts — file measurements, see §6 */ });
intake.on('ui',      (ui)               => { /* UI changed after update() */ });
intake.on('error',   ({ code, message }) => { /* recoverable iframe error */ });
intake.on('proof',   (payload)           => { /* soft-proof ready — see §5 */ });
intake.on('destroy', ()                  => { /* element unmounted */ });

intake.update({
    workflowId?:   'wf_...',
    jobId?:        'job_...',
    locale?:       'fr-CA',
    ui?:           { theme: 'dark' },
    presentation?: 'dialog',
});

intake.focus();                     // open modal/drawer layout programmatically
intake.blur();
intake.respondToProof(true);        // approve soft-proof gate (see §5)
intake.setConnector({ … });         // replace the active connector at runtime (see §6)
intake.applyNow();                  // re-run the connector against the last facts
intake.unmount();
```

`on()` returns an unsubscribe function.

### 3.2 `Filecheck.mount(config)` — zero-JS plugin integration

For plugins (WordPress, PrestaShop, OpenCart, Shopify) where all configuration
is known server-side, `Filecheck.mount` provides a single call that handles
mounting, cart-button gating, proof gallery, and optional CSS/JS injection.
It returns the `IntakeElement` so you can attach platform-specific listeners.

Wait for `.mount` to be available (it is attached at the same time as the
`Filecheck` factory):

```js
function whenReady(cb, timeout) {
    var start = Date.now();
    (function tick() {
        if (window.Filecheck && window.Filecheck.mount) return cb();
        if (Date.now() - start > (timeout || 10000)) return;
        setTimeout(tick, 50);
    })();
}

whenReady(function() {
    var el = window.Filecheck.mount({
        publishableKey: 'pk_live_...',
        workflowId:     'wf_...',
        presentation:   'inline',       // or 'dialog'
        agentId:        null,           // optional
        mountSelector:  '#fc-slot',     // fallback if #fc-inline absent
        connectorId:    'cntr_...',     // optional — fetched server-side
        cartButtonSelector: '.my-btn', // optional extra cart selector
        elementTheme:   'light',        // optional
        customCss:      '…',            // optional — injected into <head>
        customJs:       '…',            // optional — eval'd after mount
    });

    // el is the IntakeElement — attach any platform-specific listeners here
    if (el) {
        el.on('status', function(e) {
            document.getElementById('fc_job_id').value = e.jobId || '';
        });
    }
});
```

**What `Filecheck.mount` handles automatically:**
- Resolves the mount target (`#fc-inline` → `mountSelector` → last resort next to cart button)
- Creates and positions the `<dialog>` trigger button when `presentation: 'dialog'`
- Gates all cart buttons matching the built-in selector list + `cartButtonSelector` on `canProceed`
- Wires the proof gallery (built-in lightbox, no host code required)
- Injects `customCss` / `customJs`

The only thing left to the plugin is platform-specific concerns such as
writing `jobId` into a hidden form field for server-side order validation.

---

## 4. The `status` event

**Gate your "Add to Cart" / "Submit" button on `canProceed`.**

```ts
interface IntakeStatusPayload {
    status:     'idle'        // no files yet (fires once at startup)
              | 'incomplete'  // fewer files than required
              | 'uploading'
              | 'processing'
              | 'ready'       // all files passed
              | 'partial'     // warnings only, or policy = accept_with_warnings
              | 'rejected';   // hard fail
    terminal:   boolean;
    canProceed: boolean;      // ← gate your submit button on THIS
    workflowId: string | null;
    jobId:      string | null;
    files: Array<{
        id:        string;
        name:      string;
        fileRef:   string | null;  // input file CDN ref
        outcome:   'pass' | 'warn' | 'fail' | null;
        status:    string;
        outputRef: string | null;  // auto-fixed output CDN ref (if any)
    }>;
}
```

`canProceed` is `true` only for `ready` and `partial`. Do **not** re-derive
it from `status` or `files` — Filecheck already collapses the workflow's
`onFail` policy into it.

**Minimal pattern:**

```js
intake.on('status', ({ canProceed, jobId }) => {
    submitBtn.disabled = !canProceed;
    hiddenJobIdInput.value = jobId ?? '';
});
```

---

## 5. Soft-proof gate (optional)

When the merchant enables proofing on the Workflow, the element fires `proof`
once pages are rendered:

```ts
interface ProofPayload {
    pages: Array<{ url: string; page: number; width: number; height: number; mimeType: string; bytes: number; key: string }>;
    approvalRequired?: boolean;  // if true, workflow halts until respondToProof() called
    message?:          string;
    affirmButtonText?: string;
}
```

```js
intake.on('proof', ({ pages, approvalRequired }) => {
    if (!approvalRequired) return; // informational only

    showProofGallery(pages, {
        onApprove: () => intake.respondToProof(true),
        onReject:  () => intake.respondToProof(false),
    });
});
```

If you don't implement a custom gallery, ignore the `proof` event — the
built-in iframe gallery handles it automatically.

---

## 6. Connector — sync file facts to product-page controls

A **Connector** maps facts Filecheck derives about the uploaded file (page
count, page dimensions, area) onto the host product page's own controls
(quantity, width, height, size). The merchant authors it in the Filecheck
admin (**Library → Connectors**); the plugin just passes it to the element,
which writes the values into the page DOM automatically on every `status`
update. **No host wiring is required** beyond supplying the config.

Typical uses: set **quantity** from page count (multi-page PDF → N prints),
or fill **width/height** inputs from the artwork's dimensions (canvas, banner,
sticker), with unit conversion.

### 6.1 The `facts` event

Independently of any connector, the element emits `facts` alongside every
`status` event so you can drive your own custom logic:

```ts
interface IntakeFacts {
    files: Array<{
        id: string | null;
        name: string | null;
        pageCount: number | null;
        width:  number | null;   // mm
        height: number | null;   // mm
        area:   number | null;   // mm²
        orientation: string | null;
        spotColorCount: number;
        usesTransparency: boolean;
    }>;
    aggregate: {
        fileCount: number;
        pageCount: number;       // summed across files
        width:  number | null;   // first file (mm)
        height: number | null;   // first file (mm)
        area:   number | null;   // first file (mm²)
    };
}
```

```js
intake.on('facts', (facts) => {
    // e.g. drive a custom price preview
    console.log(facts.aggregate.pageCount, facts.aggregate.width);
});
```

> Dimensions are always millimetres. Multi-file uploads use the **first
> file** for width/height/area; counts aggregate across all files.

### 6.2 Applying a connector

Pass the connector config inline. The element resolves each binding's value
and writes it to the first matching host element, dispatching `input` +
`change` so the theme's own framework (React/Vue/jQuery) reacts:

```js
const intake = fc.elements.create('intake', {
    workflowId: 'wf_...',
    connector: {
        title: 'Canvas size sync',
        bindings: [
            // multi-page PDF → quantity input
            { source: 'pageCount', control: 'quantity' },
            // artwork dimensions → width / height inputs, converted mm → cm
            { source: 'width',  control: 'width',  convertTo: 'cm', decimals: 1 },
            { source: 'height', control: 'height', convertTo: 'cm', decimals: 1 },
            // area in cm² (conversion factor is squared automatically), rounded up
            { source: 'area',   control: 'area',   convertTo: 'cm', round: 'ceil' },
        ],
    },
    onConnectorApply: (results) => console.log('connector applied', results),
});
```

You can also set or replace the connector at runtime:

```js
intake.setConnector(connectorConfig);  // re-applies against the last facts
intake.applyNow();                      // force a re-apply (e.g. after DOM swap)
```

### 6.3 Binding shape

```ts
interface ConnectorBinding {
    source:          'pageCount' | 'fileCount' | 'width' | 'height' | 'area';
    control?:        'quantity' | 'width' | 'height' | 'area';  // auto-fills preset selectors
    customSelector?: string;        // CSS selector tried FIRST (theme-specific)
    set?:            'value' | 'text' | 'attr';  // how to write (default 'value')
    attr?:           string;        // attribute name when set === 'attr'
    emit?:           string[];      // DOM events to dispatch (default ['input','change'])
    convertFrom?:    number | string;  // source unit: 'mm'|'cm'|'in'|'pt' or mm-per-unit
    convertTo?:      number | string;  // host unit:   'mm'|'cm'|'in'|'pt' or mm-per-unit
    decimals?:       number | null;    // rounding precision (null = none)
    round?:          'round' | 'floor' | 'ceil';
    enabled?:        boolean;
}
```

**Target resolution order:** `customSelector` (if set) → the built-in preset
selectors for the chosen `control` → first match wins. The preset selectors
cover common Shopify / WooCommerce / PrestaShop / Magento patterns
(`input[name="quantity"]`, `.qty`, `#width`, …). When a merchant's theme uses
different markup, they add a `customSelector` in the admin — **the plugin does
not need to know the theme's selectors**.

**Units:** dimensional sources are millimetres at the source. `convertTo`
accepts a named unit (`mm`/`cm`/`in`/`pt`) or a raw mm-per-unit number (e.g.
`25.4` for inches). For `area` the conversion factor is squared automatically
(mm² → cm² divides by 100). Counts ignore conversion.

> **Plugin authors:** you usually don't construct bindings by hand — the
> merchant's connector arrives as JSON from your backend (which fetched it
> from Filecheck) and you pass it straight through as the `connector` option.
> The shape above is documented so you can validate/serialize it safely.

---

## 7. Loading async

`window.Filecheck` is not available immediately. Poll:

```js
function waitForFilecheck(cb, timeout = 5000) {
    const start = Date.now();
    const t = setInterval(() => {
        if (window.Filecheck) { clearInterval(t); cb(window.Filecheck); }
        else if (Date.now() - start > timeout) { clearInterval(t); console.error('Filecheck failed to load'); }
    }, 50);
}

waitForFilecheck((Filecheck) => {
    const fc = Filecheck('pk_live_...');
    const intake = fc.elements.create('intake', { workflowId: 'wf_...' });
    intake.on('status', ({ canProceed, jobId }) => { /* … */ });
    intake.mount('#fc-slot');
});
```

---

## 8. Sizing

The widget self-sizes. Give the mount `<div>` a **width** only — never set a
fixed height. The iframe is wrapped in Shadow DOM so host CSS does not affect it.

---

## 9. Multiple elements on one page

Track `canProceed` per element separately:

```js
const states = {};
function addIntake(workflowId, slotId) {
    const el = fc.elements.create('intake', { workflowId });
    el.on('status', ({ canProceed, jobId }) => {
        states[slotId] = { canProceed, jobId };
        submitBtn.disabled = !Object.values(states).every(s => s.canProceed);
    });
    el.mount('#' + slotId);
}
```

---

## 10. Server-side: persisting the `jobId`

1. Write `jobId` into a hidden form field / cart attribute when `canProceed` is `true`.
2. Attach it to the order (line item meta, order note, etc.).
3. Post-purchase: use the **secret key** server-side to fetch results:

```
GET https://api.filecheck.io/jobs/{jobId}
GET https://api.filecheck.io/jobs/{jobId}?expand=runs   # full pipeline detail
```

Retrieve `files[n].outputRef` to download the auto-fixed file.

Webhooks (`job.created`, `job.completed`) can be configured in the Filecheck
admin to push results without polling.

---

## 11. WordPress / WooCommerce recipe

Settings page fields: publishable key, secret key, agentId, default
workflowId, per-product override, presentation, "block checkout if not ready".
Optionally a **connector** per product (stored as the connector's JSON, fetched
from your backend / the Filecheck API) to drive quantity / size inputs.

```php
// Render mount slot + script on product page
add_action('woocommerce_before_add_to_cart_button', function () {
    global $product;
    $wf = get_post_meta($product->get_id(), '_fc_workflow_id', true)
          ?: get_option('fc_default_workflow_id');
    if (!$wf) return;
    $pk           = esc_js(get_option('fc_publishable_key'));
    $pk_attr      = esc_attr(get_option('fc_publishable_key'));
    $agent        = esc_js(get_option('fc_agent_id'));
    $presentation = esc_js(get_option('fc_presentation', 'inline'));
    $pid          = (int) $product->get_id();
    $connector_id = esc_js(get_post_meta($pid, '_fc_connector_id', true) ?: '');

    echo "<div id='fc-slot-{$pid}'></div>";
    echo "<input type='hidden' name='fc_job_id' id='fc-job-id-{$pid}' value=''>";

    wp_enqueue_script('filecheck', "https://cdn.filecheck.io/element/{$pk_attr}/filecheck.js", [], null, true);

    // Use Filecheck.mount — handles cart gating, dialog, and proof gallery
    // automatically. Only the jobId hidden-input write is WooCommerce-specific.
    wp_add_inline_script('filecheck', "
        (function() {
            var started = Date.now();
            (function tick() {
                if (window.Filecheck && window.Filecheck.mount) {
                    var el = window.Filecheck.mount({
                        publishableKey: '{$pk}',
                        workflowId:     '{$wf}',
                        presentation:   '{$presentation}',
                        agentId:        '{$agent}' || null,
                        mountSelector:  '#fc-slot-{$pid}',
                        connectorId:    '{$connector_id}' || undefined,
                    });
                    if (el) {
                        el.on('status', function(e) {
                            document.getElementById('fc-job-id-{$pid}').value = e.jobId || '';
                        });
                    }
                    return;
                }
                if (Date.now() - started < 10000) setTimeout(tick, 50);
            })();
        })();
    ");
});

// Block cart-add server-side
add_filter('woocommerce_add_to_cart_validation', function ($valid, $product_id) {
    if (get_post_meta($product_id, '_fc_required', true) && empty($_POST['fc_job_id'])) {
        wc_add_notice('Please upload and validate your file first.', 'error');
        return false;
    }
    return $valid;
}, 10, 2);

// Persist jobId on cart → order
add_filter('woocommerce_add_cart_item_data', function ($data) {
    if (!empty($_POST['fc_job_id']))
        $data['fc_job_id'] = sanitize_text_field($_POST['fc_job_id']);
    return $data;
});
add_action('woocommerce_checkout_create_order_line_item', function ($item, $key, $values) {
    if (!empty($values['fc_job_id']))
        $item->update_meta_data('Filecheck Job', $values['fc_job_id']);
}, 10, 3);
```

---

## 12. Shopify recipe

1. **Theme app extension block** — drops `<div id="fc-slot">` + script tag onto
   the product page. Block settings: workflowId, presentation. Per-product via
   metafield `filecheck.workflowId`.
2. **Cart attributes** — write `jobId` to `cart.attributes['Filecheck Job']` via
   AJAX Cart API once `canProceed === true`; disable Add to Cart client-side until then.
3. **Order webhooks** (`orders/paid`) — read `note_attributes['Filecheck Job']`,
   call `GET /jobs/{id}` with the secret key, attach output file via Files API.
4. **Embedded admin** (Polaris + App Bridge) — key entry, workflow picker,
   default presentation, metafield writer.
5. **Connector (optional)** — store the connector JSON in a metafield
   (`filecheck.connector`) and pass it as the `connector` option to drive
   quantity / size inputs from file facts (§6).
6. **Billing** — usage-based via Shopify Billing API (per-check).

---

## 13. OpenCart / PrestaShop recipe

Same pattern as WordPress. All three platforms share identical front-end output:

```html
<div id="fc-inline"></div>
<input type="hidden" name="fc_job_id" id="fc-job-id" value="">
<script src="https://cdn.filecheck.io/element/{pk}/filecheck.js" async></script>
<script>
(function() {
    var started = Date.now();
    (function tick() {
        if (window.Filecheck && window.Filecheck.mount) {
            var el = window.Filecheck.mount({
                publishableKey: '{pk}',
                workflowId:     '{workflowId}',
                presentation:   '{presentation}',
                agentId:        '{agentId}' || null,
                connectorId:    '{connectorId}' || undefined,
            });
            if (el) {
                el.on('status', function(e) {
                    document.getElementById('fc-job-id').value = e.jobId || '';
                });
            }
            return;
        }
        if (Date.now() - started < 10000) setTimeout(tick, 50);
    })();
})();
</script>
```

`Filecheck.mount` handles mounting into `#fc-inline`, cart-button gating,
dialog creation, and the proof gallery. The only platform-specific code is
the `status` → hidden `fc_job_id` write for server-side order validation.

Per-platform differences are limited to:
- **Module admin**: store publishable key, secret key, agentId, default workflowId, presentation, per-product workflowId / connectorId overrides.
- **Add-to-cart / checkout**: validate `jobId` was submitted; persist as order attribute.
- **Post-purchase**: use the secret key server-side to fetch output and attach to the order.

---

## 14. Common mistakes

| Mistake | Correct approach |
| --- | --- |
| `elements.create('intake', { ruleId: '…' })` | Option is `workflowId`, not `ruleId` |
| Re-deriving `canProceed` from `status` or `files` | Use `canProceed` as-is |
| Secret key `sk_…` in browser JS | Server-side only |
| Fixed `height` on the mount div | Set `width` only; widget self-sizes |
| Using `v1/filecheck.js` in a plugin | Use `/{pk}/filecheck.js` — embeds tenant config, one fewer request |
| Calling `Filecheck()` before async script loads | Use the polling helper (§7) |
| Two elements, assuming one controls both | Track `canProceed` per element (§9) |
| Ignoring `proof` event when `approvalRequired: true` | Call `respondToProof()` or workflow stalls |
| Hand-building connector bindings in the plugin | Pass `connectorId` (§3.2) or the connector JSON as the `connector` option (§6) |
| Expecting the connector to know your theme's selectors | Merchant adds a `customSelector` in admin; plugin stays theme-agnostic |
| Calling `fc.elements.create` + `el.mount` in a plugin | Use `Filecheck.mount(config)` (§3.2) — gets cart gating, dialog, and proof gallery for free |
| Polling for `window.Filecheck` without checking `.mount` | Check `window.Filecheck && window.Filecheck.mount` — both are attached simultaneously |
```
