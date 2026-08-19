import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { ScrollShadow } from '.';

const meta = {
  title: 'Components/ScrollShadow',
  component: ScrollShadow,
  tags: ['autodocs'],
  args: {
    size: 40,
    offset: 0,
    orientation: 'vertical',
    visibility: 'auto',
    isEnabled: true,
    onVisibilityChange: fn(),
  },
  argTypes: {
    size: {
      control: { type: 'range', min: 0, max: 120, step: 4 },
    },
    offset: {
      control: { type: 'range', min: 0, max: 120, step: 4 },
    },
    orientation: {
      control: 'select',
      options: ['vertical', 'horizontal'],
    },
    visibility: {
      control: 'select',
      options: ['auto', 'both', 'top', 'bottom', 'left', 'right', 'none'],
    },
    onVisibilityChange: { control: false },
    children: { control: false },
    ref: { control: false, table: { disable: true } },
  },
} satisfies Meta<typeof ScrollShadow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Vertical: Story = {
  args: { orientation: 'vertical' },
  render: (args) => (
    <ScrollShadow
      {...args}
      className="h-48 w-64 rounded-md border border-stroke p-4"
    >
      <div className="flex flex-col gap-3">
        {Array.from({ length: 20 }, (_, i) => (
          <p key={`row-${i + 1}`} className="text-ink-body">
            Scrollable row {i + 1}
          </p>
        ))}
      </div>
    </ScrollShadow>
  ),
};

export const Horizontal: Story = {
  args: { orientation: 'horizontal' },
  render: (args) => (
    <ScrollShadow
      {...args}
      className="w-64 rounded-md border border-stroke p-4"
    >
      <div className="flex gap-3">
        {Array.from({ length: 20 }, (_, i) => (
          <div
            key={`col-${i + 1}`}
            className="flex size-16 shrink-0 items-center justify-center rounded-md bg-surface-chips text-ink-body"
          >
            {i + 1}
          </div>
        ))}
      </div>
    </ScrollShadow>
  ),
};
