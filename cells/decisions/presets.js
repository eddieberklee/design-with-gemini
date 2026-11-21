(function (global) {
  'use strict';

  const NS = (global.GeminiDecisions = global.GeminiDecisions || {});

  const imageCache = Object.create(null);

  function renderThermalReceipt(flagged) {
    const W = 640;
    const H = 420;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = flagged ? '#e4e0d8' : '#ecebe7';
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = 'rgba(20, 20, 19, 0.08)';
    ctx.fillRect(156, 26, 336, 376);

    ctx.fillStyle = '#fdfcf9';
    ctx.fillRect(150, 20, 336, 376);
    ctx.strokeStyle = '#dedcd6';
    ctx.lineWidth = 1;
    ctx.strokeRect(150.5, 20.5, 335, 375);

    ctx.fillStyle = '#ecebe7';
    for (let x = 158; x < 482; x += 12) {
      ctx.beginPath();
      ctx.arc(x, 20, 3, 0, Math.PI, false);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, 396, 3, Math.PI, Math.PI * 2, false);
      ctx.fill();
    }

    ctx.fillStyle = '#1d1d1b';
    ctx.textAlign = 'center';
    ctx.font = '700 18px ui-monospace, Menlo, monospace';
    ctx.fillText('MERCER & PINE BISTRO', 318, 56);
    ctx.font = '400 12px ui-monospace, Menlo, monospace';
    ctx.fillStyle = '#5c5a55';
    ctx.fillText('241 BLEECKER ST · NEW YORK NY', 318, 74);
    ctx.fillText(flagged ? 'CHK #4819 · 11:42 PM · BAR TABLE 7' : 'CHK #4102 · 12:38 PM · CLIENT LUNCH', 318, 92);

    ctx.strokeStyle = '#cfccc4';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(172, 108);
    ctx.lineTo(464, 108);
    ctx.stroke();
    ctx.setLineDash([]);

    const rows = flagged
      ? [
          ['2x HOUSE NEGRONI', '$36.00'],
          ['1x SINGLE MALT FLIGHT', '$48.00'],
          ['1x TRUFFLE FRITES', '$14.00'],
          ['1x ESPRESSO MARTINI', '$22.00']
        ]
      : [
          ['2x ROASTED SALMON BOWL', '$32.00'],
          ['2x SPARKLING WATER', '$6.50'],
          ['1x ESPRESSO', '$4.00']
        ];

    ctx.font = '500 13px ui-monospace, Menlo, monospace';
    ctx.fillStyle = '#1d1d1b';
    let y = 136;
    rows.forEach(function (row) {
      ctx.textAlign = 'left';
      ctx.fillText(row[0], 174, y);
      ctx.textAlign = 'right';
      ctx.fillText(row[1], 462, y);
      y += 26;
    });

    ctx.strokeStyle = '#cfccc4';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(172, y + 4);
    ctx.lineTo(464, y + 4);
    ctx.stroke();
    ctx.setLineDash([]);

    y += 28;
    const summary = flagged
      ? [
          ['SUBTOTAL', '$120.00'],
          ['NY TAX (8.875%)', '$10.65'],
          ['HANDWRITTEN TIP', '$45.00'],
          ['TOTAL CHARGED', '$191.65']
        ]
      : [
          ['SUBTOTAL', '$42.50'],
          ['NY TAX (8.875%)', '$3.77'],
          ['TIP (18%)', '$7.65'],
          ['TOTAL CHARGED', '$53.92']
        ];

    summary.forEach(function (row, idx) {
      const isTotal = idx === summary.length - 1;
      ctx.font = (isTotal ? '700 15px' : '500 13px') + ' ui-monospace, Menlo, monospace';
      ctx.fillStyle = isTotal ? '#141413' : '#4a4844';
      ctx.textAlign = 'left';
      ctx.fillText(row[0], 174, y);
      ctx.textAlign = 'right';
      ctx.fillText(row[1], 462, y);
      y += isTotal ? 26 : 22;
    });

    if (flagged) {
      const grad = ctx.createLinearGradient(180, 282, 440, 346);
      grad.addColorStop(0, 'rgba(255, 252, 240, 0.0)');
      grad.addColorStop(0.5, 'rgba(255, 250, 235, 0.56)');
      grad.addColorStop(1, 'rgba(255, 252, 240, 0.0)');
      ctx.fillStyle = grad;
      ctx.fillRect(160, 282, 318, 64);

      ctx.strokeStyle = 'rgba(217, 79, 30, 0.65)';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.ellipse(422, y - 31, 46, 15, -0.05, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.fillStyle = '#2c2c29';
    let bx = 214;
    for (let i = 0; i < 48; i++) {
      const w = (i * 7 + (flagged ? 3 : 1)) % 3 === 0 ? 3 : 1.5;
      ctx.fillRect(bx, 354, w, 24);
      bx += w + 2.5;
    }

    return canvas;
  }

  function renderCheckoutMockup(regressed) {
    const W = 640;
    const H = 420;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#f4f4f2';
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(108, 36, 424, 348);
    ctx.strokeStyle = '#e2e2de';
    ctx.lineWidth = 1;
    ctx.strokeRect(108.5, 36.5, 423, 347);

    ctx.fillStyle = '#141413';
    ctx.font = '600 13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('CHECKOUT · STUDIO PLAN', 136, 72);

    ctx.fillStyle = '#8a8a86';
    ctx.font = '500 11px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.fillText('STEP 2 OF 2', 504, 72);

    ctx.strokeStyle = '#efefef';
    ctx.beginPath();
    ctx.moveTo(109, 88);
    ctx.lineTo(531, 88);
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.fillStyle = '#141413';
    ctx.font = '600 22px -apple-system, BlinkMacSystemFont, sans-serif';
    if (regressed) {
      ctx.fillText('Annual Team Workspace Subscript...', 136, 130);
      ctx.fillStyle = '#fde68a';
      ctx.fillRect(390, 110, 128, 28);
      ctx.fillStyle = '#92400e';
      ctx.font = '700 12px ui-monospace, Menlo, monospace';
      ctx.fillText('SAVE 20% NOW', 402, 128);
    } else {
      ctx.fillText('Annual Team Workspace', 136, 132);
      ctx.fillStyle = '#eef2ff';
      ctx.fillRect(422, 114, 82, 24);
      ctx.fillStyle = '#3730a3';
      ctx.font = '600 11px ui-monospace, Menlo, monospace';
      ctx.fillText('SAVE 20%', 435, 130);
    }

    ctx.fillStyle = '#525250';
    ctx.font = '400 13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText('Unlimited projects, live previews, and team seats.', 136, 158);

    ctx.fillStyle = '#fafaf8';
    ctx.fillRect(136, 180, 368, 92);
    ctx.strokeStyle = '#ecece8';
    ctx.strokeRect(136.5, 180.5, 367, 91);

    ctx.fillStyle = '#525250';
    ctx.font = '500 13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText('Seats (5 × $18/mo)', 154, 212);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#141413';
    ctx.font = '600 13px ui-monospace, Menlo, monospace';
    ctx.fillText('$90.00 / mo', 486, 212);

    ctx.textAlign = 'left';
    ctx.fillStyle = '#525250';
    ctx.font = '500 13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText('Due today (annual billing)', 154, 248);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#141413';
    ctx.font = '700 16px ui-monospace, Menlo, monospace';
    ctx.fillText('$1,080.00', 486, 248);

    if (regressed) {
      ctx.fillStyle = '#e7e7e4';
      ctx.fillRect(136, 298, 368, 46);
      ctx.fillStyle = '#b9b9b4';
      ctx.font = '600 14px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Complete Purchase ($1,080.00)', 320, 326);
    } else {
      ctx.fillStyle = '#141413';
      ctx.fillRect(136, 298, 368, 46);
      ctx.fillStyle = '#ffffff';
      ctx.font = '600 14px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Complete Purchase · $1,080.00', 320, 326);
    }

    ctx.fillStyle = '#8a8a86';
    ctx.font = '400 11px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText('Instant receipt · Cancel anytime in billing settings', 320, 366);

    return canvas;
  }

  function generateSampleImage(kind) {
    if (imageCache[kind]) {
      return Object.assign({}, imageCache[kind]);
    }

    let canvas;
    let name;
    if (kind === 'receipt_clean') {
      canvas = renderThermalReceipt(false);
      name = 'receipt-clean.png';
    } else if (kind === 'receipt_flagged') {
      canvas = renderThermalReceipt(true);
      name = 'receipt-flagged.png';
    } else if (kind === 'ui_clean') {
      canvas = renderCheckoutMockup(false);
      name = 'checkout-polished.png';
    } else {
      canvas = renderCheckoutMockup(true);
      name = 'checkout-regressed.png';
    }

    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1] || '';
    const bytes = NS.Schema.estimateBase64Bytes(base64);

    const record = {
      kind: kind,
      name: name,
      mimeType: 'image/png',
      width: canvas.width,
      height: canvas.height,
      bytes: bytes,
      data: base64,
      dataUrl: dataUrl
    };
    imageCache[kind] = record;
    return Object.assign({}, record);
  }

  const SAMPLE_IMAGES = [
    { kind: 'receipt_clean', label: 'Receipt — Clean ($53.92)' },
    { kind: 'receipt_flagged', label: 'Receipt — Bar Tab + Math Error' },
    { kind: 'ui_clean', label: 'Checkout UI — Polished' },
    { kind: 'ui_regressed', label: 'Checkout UI — Low Contrast + Overlap' }
  ];

  const LIST = [
    {
      id: 'receipt',
      shortLabel: 'Receipt',
      title: 'Expense Receipt Audit',
      variants: [
        {
          id: 'clean',
          label: 'Clean Lunch',
          buttonLabel: 'Clean Lunch ($54)',
          title: 'Mercer & Pine · Client Lunch',
          bullets: ['$53.92 · Salmon bowls + water', 'Exact subtotal, tax & 18% tip'],
          summary: 'Client lunch · $53.92 itemized, exact math',
          imageKind: 'receipt_clean',
          resolution: 'medium',
          text: 'Expense claim submitted under Client Meals ($53.92). Policy: max $75/person, no standalone bar tabs, totals must reconcile.'
        },
        {
          id: 'flagged',
          label: 'Bar Tab',
          buttonLabel: 'Bar Tab ($192)',
          title: 'Mercer & Pine · 11:42 PM Bar',
          bullets: ['$191.65 · Cocktails + spirits flight', 'Total off by $16 · glare on tip'],
          summary: 'Late bar tab · $191.65 mismatch + glare',
          imageKind: 'receipt_flagged',
          resolution: 'medium',
          text: 'Expense claim submitted under Client Meals ($191.65). Policy: max $75/person, no standalone bar tabs, totals must reconcile.'
        }
      ],
      questions: [
        {
          id: 'q-rec-noul',
          enabled: true,
          key: 'policy_violation',
          cardQuestion: 'Breaks expense policy?',
          type: 'noul',
          instructions: 'Does this receipt violate expense policy (alcohol-heavy bar tab, over limit, or arithmetic mismatch)?',
          trueDescription: 'Shows alcohol/bar tab items, exceeds limit, or total does not match subtotal + tax + tip.',
          falseDescription: 'Standard meal items within budget with accurate subtotal, tax, tip, and total.',
          threshold: 0.5
        },
        {
          id: 'q-rec-choice',
          enabled: true,
          key: 'expense_category',
          cardQuestion: 'Which expense bucket?',
          type: 'choice',
          instructions: 'Which finance ledger category best fits this receipt?',
          options: [
            { key: 'meals_client', label: 'Client Meals', description: 'Compliant client dining and non-alcoholic food/beverage.' },
            { key: 'unallowable_bar', label: 'Bar Tab', description: 'Alcohol-dominated bar tab or non-reimbursable entertainment.' },
            { key: 'travel_transit', label: 'Travel', description: 'Flights, rail, rideshare, or lodging receipts.' },
            { key: 'needs_manual_audit', label: 'Manual Audit', description: 'Unclear, obscured, or mismatched receipt requiring human review.' }
          ]
        },
        {
          id: 'q-rec-score',
          enabled: true,
          key: 'audit_readiness',
          cardQuestion: 'Ready to auto-approve?',
          type: 'score',
          instructions: 'Rate how ready this receipt is for automatic reimbursement approval.',
          levelLabels: ['Reject', 'Hold', 'Review', 'Auto-OK'],
          levels: [
            'Reject: clear policy breach or unreadable totals.',
            'Hold: visible anomaly or glare requires manual finance audit.',
            'Conditional: mostly clear, minor clarification recommended.',
            'Auto-approve: crisp itemized receipt that fully reconciles.'
          ]
        }
      ]
    },
    {
      id: 'support',
      shortLabel: 'Ticket',
      title: 'Support Ticket Triage',
      variants: [
        {
          id: 'calm',
          label: 'Minor Bug',
          buttonLabel: 'Minor Bug',
          title: 'Customer Support Email',
          bullets: ['Safari CSV export fails silently', 'Chrome works fine · low urgency'],
          summary: 'Safari CSV export fails; Chrome works fine',
          imageKind: null,
          resolution: 'medium',
          text: 'Hi team — quick heads-up: exporting our monthly CSV report fails silently in Safari 18, though switching to Chrome exports cleanly. No rush, just logging it for your sprint.'
        },
        {
          id: 'urgent',
          label: 'Billing Crisis',
          buttonLabel: '$4,800 Billing Crisis',
          title: 'Urgent Enterprise Escalation',
          bullets: ['Double-charged $4,800 + SSO lockout', '40 users blocked · chargeback threat'],
          summary: 'Duplicate $4,800 charge + legal threat',
          imageKind: null,
          resolution: 'medium',
          text: 'URGENT: Your billing system double-charged our enterprise card $4,800 twice this morning and locked our entire 40-person workspace out of SSO. If this is not refunded and restored within 2 hours we are filing a chargeback.'
        }
      ],
      questions: [
        {
          id: 'q-sup-noul',
          enabled: true,
          key: 'needs_escalation',
          cardQuestion: 'Page on-call lead now?',
          type: 'noul',
          instructions: 'Should this ticket immediately page an on-call lead or executive escalation queue?',
          trueDescription: 'Revenue/billing dispute, workspace outage, legal/chargeback threat, or zero workaround.',
          falseDescription: 'Routine bug report or general inquiry with a viable workaround and low urgency.',
          threshold: 0.5
        },
        {
          id: 'q-sup-choice',
          enabled: true,
          key: 'routing_queue',
          cardQuestion: 'Which team owns this?',
          type: 'choice',
          instructions: 'Which support team should own this ticket first?',
          options: [
            { key: 'engineering', label: 'Engineering', description: 'Software bugs, browser incompatibilities, and technical defects.' },
            { key: 'billing', label: 'Billing', description: 'Duplicate charges, invoices, refunds, and chargeback disputes.' },
            { key: 'account_access', label: 'Account Access', description: 'SSO lockouts, permissions, and authentication failures.' },
            { key: 'general', label: 'General', description: 'How-to questions, pricing info, or feedback.' }
          ]
        },
        {
          id: 'q-sup-score',
          enabled: true,
          key: 'severity',
          cardQuestion: 'How severe is this ticket?',
          type: 'score',
          instructions: 'Rate customer operational severity for SLA triage.',
          levelLabels: ['Cosmetic', 'Minor', 'Degraded', 'Critical'],
          levels: [
            'Cosmetic: minor UI polish issue, full workflow works.',
            'Workaround: one path fails, but another browser/method succeeds.',
            'Degraded: core feature impaired with material friction.',
            'Critical: blocked workflow, outage, or active billing dispute.'
          ]
        }
      ]
    },
    {
      id: 'ui_qa',
      shortLabel: 'UI QA',
      title: 'UI Craft & A11y QA',
      variants: [
        {
          id: 'polished',
          label: 'Polished UI',
          buttonLabel: 'Polished UI',
          title: 'Checkout Card · Clean Build',
          bullets: ['High-contrast dark primary CTA', 'Clean spacing & aligned badge'],
          summary: 'High-contrast CTA · clean Swiss spacing',
          imageKind: 'ui_clean',
          resolution: 'medium',
          text: 'Pre-release visual QA snapshot of the Annual Team Workspace checkout card. Check contrast, text clipping, and layout overlap.'
        },
        {
          id: 'regressed',
          label: 'Broken UI',
          buttonLabel: 'Broken UI',
          title: 'Checkout Card · Visual Bugs',
          bullets: ['Washed-out unreadable CTA button', 'Promo badge collides with title'],
          summary: 'Low-contrast CTA + colliding promo badge',
          imageKind: 'ui_regressed',
          resolution: 'medium',
          text: 'Pre-release visual QA snapshot of the Annual Team Workspace checkout card. Check contrast, text clipping, and layout overlap.'
        }
      ],
      questions: [
        {
          id: 'q-ui-noul',
          enabled: true,
          key: 'ship_ready',
          cardQuestion: 'Ready to ship as-is?',
          type: 'noul',
          instructions: 'Is this UI screen ready to ship to production without visual or accessibility fixes?',
          trueDescription: 'Strong text contrast, clean alignment, no overlapping elements or truncated headlines.',
          falseDescription: 'Contains WCAG contrast defects, overlapping badges/text, or broken hierarchy.',
          threshold: 0.5
        },
        {
          id: 'q-ui-choice',
          enabled: true,
          key: 'primary_issue',
          cardQuestion: 'Main visual QA finding?',
          type: 'choice',
          instructions: 'What is the dominant visual QA finding in this screenshot?',
          options: [
            { key: 'clean_pass', label: 'Clean Pass', description: 'No visual or accessibility defects observed.' },
            { key: 'contrast_a11y', label: 'Contrast Fail', description: 'Button or text contrast fails WCAG AA legibility.' },
            { key: 'layout_overlap', label: 'Layout Overlap', description: 'Elements collide, overlap, or truncate headline copy.' },
            { key: 'spacing_hierarchy', label: 'Spacing', description: 'Misaligned margins or unclear pricing hierarchy.' }
          ]
        },
        {
          id: 'q-ui-score',
          enabled: true,
          key: 'visual_craft',
          cardQuestion: 'Overall UI polish?',
          type: 'score',
          instructions: 'Score overall visual craft and accessibility polish.',
          levelLabels: ['Broken', 'Poor', 'Okay', 'Polished'],
          levels: [
            'Broken: severe collision or unreadable primary action.',
            'Poor: noticeable contrast failure or clipping defects.',
            'Acceptable: usable, minor alignment or rhythm blemishes.',
            'Polished: crisp hierarchy, balanced spacing, strong contrast.'
          ]
        }
      ]
    },
    {
      id: 'release',
      shortLabel: 'PR Gate',
      title: 'PR Release Gate',
      variants: [
        {
          id: 'safe',
          label: 'Safe Patch',
          buttonLabel: 'Safe Patch',
          title: 'PR #842 · Date Guard Fix',
          bullets: ['Adds null guard + 4 unit tests', 'No public API or schema changes'],
          summary: 'Null guard in date formatter + unit test',
          imageKind: null,
          resolution: 'medium',
          text: 'PR #842: Guard against undefined timezone offset in formatRelativeDate(). Added 4 unit tests covering UTC and DST boundaries. No public API signatures or storage schemas changed.'
        },
        {
          id: 'breaking',
          label: 'Breaking PR',
          buttonLabel: 'Breaking Auth PR',
          title: 'PR #849 · Auth Removal',
          bullets: ['Drops /v1/auth & renames JWT claim', 'Breaks mobile < 3.4 · no migration'],
          summary: 'Drops /v1/auth + changes JWT claim schema',
          imageKind: null,
          resolution: 'medium',
          text: 'PR #849: Remove deprecated /v1/auth/session endpoint and rename JWT claim org_id to tenant_uuid across all API middleware. Existing mobile clients (< 3.4) will receive 401 until upgraded; no migration script included.'
        }
      ],
      questions: [
        {
          id: 'q-rel-noul',
          enabled: true,
          key: 'needs_migration_guide',
          cardQuestion: 'Needs migration guide?',
          type: 'noul',
          instructions: 'Does this pull request require a breaking-change migration guide before release?',
          trueDescription: 'Removes endpoints, alters wire/token contracts, or breaks older clients.',
          falseDescription: 'Backward-compatible internal fix or additive change with no client impact.',
          threshold: 0.5
        },
        {
          id: 'q-rel-choice',
          enabled: true,
          key: 'semver_bump',
          cardQuestion: 'Required version bump?',
          type: 'choice',
          instructions: 'Which semantic version bump does this change require?',
          options: [
            { key: 'patch', label: 'Patch', description: 'Backward-compatible bug fix with no new public API.' },
            { key: 'minor', label: 'Minor', description: 'Backward-compatible new capability or optional field.' },
            { key: 'major', label: 'Major', description: 'Breaking API/auth removal or incompatible schema change.' }
          ]
        },
        {
          id: 'q-rel-score',
          enabled: true,
          key: 'blast_radius',
          cardQuestion: 'Production blast radius?',
          type: 'score',
          instructions: 'Rate production blast radius if deployed directly to 100% traffic.',
          levelLabels: ['Trivial', 'Low', 'Moderate', 'High'],
          levels: [
            'Trivial: isolated pure function with regression tests.',
            'Low: scoped module with easy rollback.',
            'Moderate: touches shared runtime path or state.',
            'High: breaks active clients or authentication flows.'
          ]
        }
      ]
    }
  ];

  function cloneQuestions(questions) {
    return questions.map(function (q) {
      const copy = Object.assign({}, q);
      if (Array.isArray(q.options)) {
        copy.options = q.options.map(function (o) {
          return Object.assign({}, o);
        });
      }
      if (Array.isArray(q.levels)) {
        copy.levels = q.levels.slice();
      }
      if (Array.isArray(q.levelLabels)) {
        copy.levelLabels = q.levelLabels.slice();
      }
      return copy;
    });
  }

  function getPreset(presetId) {
    for (let i = 0; i < LIST.length; i++) {
      if (LIST[i].id === presetId) return LIST[i];
    }
    return LIST[0];
  }

  function createPresetState(presetId, variantIndex) {
    const preset = getPreset(presetId);
    const idx = variantIndex >= 0 && variantIndex < preset.variants.length ? variantIndex : 0;
    const variant = preset.variants[idx];
    return {
      presetId: preset.id,
      variantIndex: idx,
      variantId: variant.id,
      inputText: variant.text,
      resolution: variant.resolution || 'medium',
      image: variant.imageKind ? generateSampleImage(variant.imageKind) : null,
      questions: cloneQuestions(preset.questions)
    };
  }

  const ALLOWED_IMAGE_MIMES = {
    'image/png': true,
    'image/jpeg': true,
    'image/webp': true,
    'image/gif': true,
    'image/bmp': true,
    'image/tiff': true,
    'image/heic': true,
    'image/heif': true
  };

  function processUploadedImage(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !file.type || !ALLOWED_IMAGE_MIMES[file.type.toLowerCase()]) {
        reject(new Error('Unsupported file type. Drop a PNG, JPEG, WebP, or GIF image.'));
        return;
      }

      const reader = new FileReader();
      reader.onerror = function () {
        reject(new Error('Could not read the selected image file.'));
      };
      reader.onload = function () {
        const rawDataUrl = String(reader.result || '');
        const img = new Image();
        img.onerror = function () {
          reject(new Error('The selected file could not be decoded as an image.'));
        };
        img.onload = function () {
          const maxEdge = 1280;
          const needsResize = img.naturalWidth > maxEdge || img.naturalHeight > maxEdge || file.size > 2.5 * 1024 * 1024;
          let targetW = img.naturalWidth;
          let targetH = img.naturalHeight;
          let finalDataUrl = rawDataUrl;
          let finalMime = file.type.toLowerCase();

          if (needsResize) {
            const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
            targetW = Math.max(1, Math.round(img.naturalWidth * scale));
            targetH = Math.max(1, Math.round(img.naturalHeight * scale));
            const canvas = document.createElement('canvas');
            canvas.width = targetW;
            canvas.height = targetH;
            const ctx = canvas.getContext('2d');
            if (finalMime === 'image/jpeg') {
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(0, 0, targetW, targetH);
              ctx.drawImage(img, 0, 0, targetW, targetH);
              finalDataUrl = canvas.toDataURL('image/jpeg', 0.88);
            } else {
              ctx.drawImage(img, 0, 0, targetW, targetH);
              finalMime = 'image/png';
              finalDataUrl = canvas.toDataURL('image/png');
            }
          }

          const base64 = finalDataUrl.split(',')[1] || '';
          const bytes = NS.Schema.estimateBase64Bytes(base64);
          resolve({
            kind: 'custom',
            name: file.name || 'uploaded-image',
            mimeType: finalMime,
            width: targetW,
            height: targetH,
            bytes: bytes,
            data: base64,
            dataUrl: finalDataUrl,
            resized: needsResize
          });
        };
        img.src = rawDataUrl;
      };
      reader.readAsDataURL(file);
    });
  }

  NS.Presets = {
    LIST: LIST,
    SAMPLE_IMAGES: SAMPLE_IMAGES,
    getPreset: getPreset,
    createPresetState: createPresetState,
    generateSampleImage: generateSampleImage,
    processUploadedImage: processUploadedImage
  };
})(window);
