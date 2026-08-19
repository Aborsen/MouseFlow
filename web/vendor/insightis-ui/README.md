# @insightis/ui

Shared component library built on Radix UI primitives, Tailwind CSS, and CVA variants.

## Importing

Always use subpath imports — never barrel-import from `@insightis/ui`:

```ts
import { Button } from '@insightis/ui/Button';
import { Modal, ModalContent, ModalHeader, ModalTitle, ModalBody, ModalFooter } from '@insightis/ui/Modal';
import { cn } from '@insightis/ui/cn';
import { useIsMobile } from '@insightis/ui/use-mobile';
```

To set up Tailwind in a consuming app:

```ts
// tailwind.config.ts
import uiConfig from '@insightis/ui/tailwind.config';
```

```css
/* globals.css */
@import '@insightis/ui/globals.css';
```

---

## Component catalog

| Component | Based on | Variants |
|---|---|---|
| **Accordion** | Radix | — |
| **Autocomplete** | Custom | — |
| **Avatar** | Radix | — |
| **Badge** | CVA | `variant`, `size`, `rounded` |
| **Button** | CVA + Radix Slot | `variant`, `size`, `align`, `rounded`, `fullWidth` |
| **Card** | HTML | — |
| **Checkbox** | Radix + CVA | `variant`, `size`, `rounded`, `labelPosition` |
| **CircularProgress** | Custom | — |
| **Collapsible** | Radix | — |
| **Datepicker** | Custom | — |
| **DropdownMenu** | Radix | — |
| **File** | Custom | — |
| **IconButton** | CVA | `variant`, `size`, `rounded` |
| **Input** | HTML | — |
| **InputGroup** | Custom | — |
| **Modal** | Radix Dialog | — |
| **Pagination** | Custom | — |
| **PasswordInput** | Custom | — |
| **Popover** | Radix | — |
| **ProgressBar** | Radix + CVA | `variant`, `size`, `rounded` |
| **ScrollShadow** | Custom | — |
| **Separator** | Radix | — |
| **Sheet** | Radix Dialog | — |
| **Sidebar** | Custom | — |
| **Skeleton** | CSS | — |
| **Spinner** | Custom | — |
| **Switch** | Radix | — |
| **Table** | HTML | — |
| **Tabs** | Radix | — |
| **Toast** | Sonner | — |
| **Tooltip** | Radix | — |
| **Typography** | HTML | — |

---

## Button variants

Button is the best reference for how CVA components work in this package:

```tsx
// Variants
<Button variant="primary">Save</Button>       // default
<Button variant="secondary">Cancel</Button>
<Button variant="outline">Edit</Button>
<Button variant="destructive">Delete</Button>
<Button variant="transparent">Learn more</Button>

// Sizes: xs | sm | md (default) | lg | xl
<Button size="sm">Small</Button>

// Slots for icons
<Button leftSlot={<PlusIcon />}>Add item</Button>
<Button rightSlot={<ChevronRightIcon />}>Next</Button>

// Full width
<Button fullWidth>Submit</Button>

// Render as a different element
<Button asChild><a href="/settings">Settings</a></Button>
```

All CVA components accept `className` which is merged via `cn()` and appended after variant classes.

---

## Radix composition pattern

Radix-based components are exported as composable named parts. Example with Modal:

```tsx
import {
  Modal, ModalContent, ModalHeader, ModalTitle,
  ModalBody, ModalFooter, ModalTrigger, ModalClose
} from '@insightis/ui/Modal';

<Modal open={isOpen} onOpenChange={setIsOpen}>
  <ModalTrigger asChild>
    <Button>Open</Button>
  </ModalTrigger>
  <ModalContent>
    <ModalHeader>
      <ModalTitle>Title</ModalTitle>
    </ModalHeader>
    <ModalBody>Content here</ModalBody>
    <ModalFooter>
      <ModalClose asChild><Button variant="secondary">Close</Button></ModalClose>
    </ModalFooter>
  </ModalContent>
</Modal>
```

The same compositional pattern applies to `Popover`, `DropdownMenu`, `Tabs`, `Tooltip`, and `Sheet`.

---

## cn() and cva() — mandatory conventions

### cn()

`cn()` is the **only** way to construct class strings in this package. Never concatenate strings or use template literals for Tailwind classes.

```ts
import { cn } from '@insightis/ui/cn';

// correct
cn('px-2 py-1', isActive && 'bg-primary', className)

// wrong — cn() resolves conflicts between Tailwind utilities; raw concatenation does not
`px-2 py-1 ${isActive ? 'bg-primary' : ''} ${className}`
```

### cva()

Any component with visual variants **must** define them with `cva()`. Do not branch on variant props with conditionals or string maps — CVA is the single source of truth for variant classes and enables typed `VariantProps`.

```ts
// correct
const badgeVariants = cva('inline-flex items-center', {
  variants: {
    variant: {
      primary: 'bg-primary text-white',
      secondary: 'bg-chip text-content-body',
    },
    size: { sm: 'h-5 text-xs', md: 'h-6 text-sm' },
  },
  defaultVariants: { variant: 'primary', size: 'md' },
});

interface BadgeProps extends VariantProps<typeof badgeVariants> {
  className?: string;
}

// wrong — ad-hoc branching instead of cva
const cls = variant === 'primary' ? 'bg-primary text-white' : 'bg-chip text-content-body';
```

Always export the variants object (e.g. `badgeVariants`) alongside the component so consumers can reuse the classes without rendering the component.

---

## Color tokens

**Never use arbitrary color values** — no hex (`#1a2b3c`), no raw hsl (`hsl(192 89% 21%)`), no Tailwind arbitrary syntax (`bg-[#1a2b3c]`). Every color must come from a token.

All tokens support the Tailwind alpha modifier (`/value`):

```ts
// correct — token with opacity
'bg-primary/20'
'text-accent/60'
'border-red/30'

// wrong — arbitrary values
'bg-[#0a3d52]'
'text-[hsl(179,94%,26%)]'
```

| Token | Tailwind class examples |
|---|---|
| `primary` | `bg-primary`, `text-primary`, `bg-primary/20` |
| `secondary` | `bg-secondary`, `text-secondary` |
| `accent` | `text-accent`, `bg-accent/10` |
| `content-primary` | `text-content-primary` |
| `content-secondary` | `text-content-secondary` |
| `content-body` | `text-content-body` |
| `content-light` | `text-content-light` |
| `background` | `bg-background` |
| `card` | `bg-card` |
| `border` | `border-border` |
| `hover` | `bg-hover` |
| `success` | `text-success`, `bg-success/10` |
| `red` | `text-red`, `bg-red/10` |
| `green` | `text-green` |
| `orange` | `text-orange` |
| `attention` | `text-attention` |
| `chip` | `bg-chip` |

Tokens are defined in `src/globals.css` as HSL CSS variables and wired in `tailwind.config.ts`. Both light and dark values are defined — theming is automatic. To add a new token, define it in `globals.css` for both `:root` and `.dark`, then expose it in `tailwind.config.ts`.

---

## Adding a new component

1. Create `src/components/<Name>/index.tsx`
2. Define variants with `cva()` if the component has visual variants; export the variants object alongside the component
3. Use only token-based color classes — no arbitrary values; add new tokens to `globals.css` + `tailwind.config.ts` if needed
4. Construct all class strings with `cn()`
5. Use a Radix primitive for any interactive behavior (focus, keyboard, a11y)
6. Support `className` prop merged via `cn(variants(...), className)`
7. Export the component and any variant types from `index.tsx` — the wildcard export in `package.json` handles the rest
