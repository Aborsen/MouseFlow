import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '../Button';
import { Toaster, ToastMessage, toast } from '.';

/**
 * Toasts are imperative: call `toast.success(...)` / `toast.error(...)` etc.
 * anywhere and the mounted `<Toaster />` (backed by `sonner`) renders them in a
 * portal. Every story mounts a `<Toaster />` via the decorator and triggers
 * toasts from buttons. `meta.component` targets `ToastMessage` — the visual
 * primitive each toast renders — so its `variant` drives the controls panel.
 */
const meta = {
  title: 'Components/Toast',
  component: ToastMessage,
  tags: ['autodocs'],
  args: {
    variant: 'info',
    message: 'Changes saved',
    description: 'Your changes have been saved successfully.',
    duration: 4000,
  },
  argTypes: {
    variant: {
      control: 'select',
      options: ['success', 'info', 'warning', 'error'],
    },
    duration: { control: 'number' },
    action: { control: false },
    icon: { control: false },
    onClose: { control: false, table: { disable: true } },
    ref: { control: false, table: { disable: true } },
  },
  decorators: [
    (Story) => (
      <div className="grid min-h-32 place-items-center">
        <Toaster />
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof ToastMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The `ToastMessage` primitive rendered inline (this is what each imperative
 * toast draws inside the portal). Use the controls to switch variants.
 */
export const Message: Story = {
  render: (args) => (
    <div className="w-80">
      <ToastMessage {...args} />
    </div>
  ),
};

/** One button per imperative variant of the `toast` helper. */
export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="outline" onClick={() => toast.success('Chat renamed')}>
        Success
      </Button>
      <Button
        variant="outline"
        onClick={() => toast.info('Draft saved automatically')}
      >
        Info
      </Button>
      <Button
        variant="outline"
        onClick={() => toast.warning('You are approaching your usage limit')}
      >
        Warning
      </Button>
      <Button
        variant="outline"
        onClick={() => toast.error('Failed to send message')}
      >
        Error
      </Button>
    </div>
  ),
};

/** A toast carrying an action button and a longer description. */
export const WithAction: Story = {
  render: () => (
    <Button
      variant="outline"
      onClick={() =>
        toast.error('Message failed to send', {
          action: { label: 'Retry', onClick: () => toast.success('Retrying') },
        })
      }
    >
      Show toast with action
    </Button>
  ),
};
