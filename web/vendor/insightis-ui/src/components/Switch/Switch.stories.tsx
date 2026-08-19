import type { Meta, StoryObj } from '@storybook/react-vite';
import { Switch } from '.';

const meta = {
  title: 'Components/Switch',
  component: Switch,
  tags: ['autodocs'],
  args: {
    label: 'Enable notifications',
    labelPosition: 'right',
    size: 'default',
    gap: 'md',
    disabled: false,
  },
  argTypes: {
    size: {
      control: 'select',
      options: ['default', 'sm'],
    },
    labelPosition: {
      control: 'select',
      options: ['left', 'right', 'top', 'bottom'],
    },
    gap: {
      control: 'select',
      options: ['sm', 'md', 'lg'],
    },
    containerVariant: {
      control: 'select',
      options: ['default', 'tertiary'],
    },
    checked: { control: false },
  },
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithLabel: Story = {};

export const States: Story = {
  render: (args) => (
    <div className="flex flex-col gap-3">
      <Switch {...args} label="Off" />
      <Switch {...args} defaultChecked label="On" />
      <Switch {...args} disabled label="Disabled off" />
      <Switch {...args} defaultChecked disabled label="Disabled on" />
    </div>
  ),
};

export const Small: Story = {
  args: { size: 'sm' },
};

export const WithoutLabel: Story = {
  args: { label: undefined, 'aria-label': 'Toggle feature' },
};

// Menu-row usage: whole labelled row gets Button-tertiary hover/pressed
// overlays (e.g. connector toggles inside the chat composer popover).
export const TertiaryRow: Story = {
  args: {
    containerVariant: 'tertiary',
    labelPosition: 'right',
    size: 'sm',
    className: 'h-8 w-56 justify-between px-3',
  },
};
