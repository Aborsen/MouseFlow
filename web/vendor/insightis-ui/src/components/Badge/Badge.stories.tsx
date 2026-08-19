import type { Meta, StoryObj } from '@storybook/react-vite';
import { Sparkles } from 'lucide-react';
import { fn } from 'storybook/test';
import { Badge } from '.';

const meta = {
  title: 'Components/Badge',
  component: Badge,
  tags: ['autodocs'],
  args: {
    children: 'Badge',
    variant: 'primary',
    size: 'md',
    rounded: 'md',
    withDot: false,
  },
  argTypes: {
    variant: {
      control: 'select',
      options: ['primary', 'secondary', 'attention', 'success', 'error'],
    },
    size: {
      control: 'select',
      options: ['xs', 'sm', 'md', 'lg', 'xl'],
    },
    rounded: {
      control: 'select',
      options: ['none', 'sm', 'md', 'lg', 'xl', 'full'],
    },
    leftSlot: { control: false },
    rightSlot: { control: false },
    onDelete: { control: false },
  },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {};

export const Variants: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-3">
      <Badge {...args} variant="primary">
        Primary
      </Badge>
      <Badge {...args} variant="secondary">
        Secondary
      </Badge>
      <Badge {...args} variant="attention">
        Attention
      </Badge>
      <Badge {...args} variant="success">
        Success
      </Badge>
      <Badge {...args} variant="error">
        Error
      </Badge>
    </div>
  ),
};

export const WithDot: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-3">
      <Badge {...args} withDot variant="success">
        Active
      </Badge>
      <Badge {...args} withDot variant="attention">
        Pending
      </Badge>
      <Badge {...args} withDot variant="error">
        Failed
      </Badge>
    </div>
  ),
};

export const WithIcon: Story = {
  args: { leftSlot: <Sparkles />, children: 'AI generated' },
};

export const Removable: Story = {
  args: { onDelete: fn(), children: 'Filter: last week' },
};
