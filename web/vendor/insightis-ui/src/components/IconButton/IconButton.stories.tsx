import type { Meta, StoryObj } from '@storybook/react-vite';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { IconButton } from '.';

const meta = {
  title: 'Components/IconButton',
  component: IconButton,
  tags: ['autodocs'],
  args: {
    children: <Plus />,
    'aria-label': 'Add',
    variant: 'primary',
    size: 'md',
    rounded: 'md',
    isLoading: false,
    disabled: false,
  },
  argTypes: {
    variant: {
      control: 'select',
      options: [
        'primary',
        'secondary',
        'outline',
        'tertiary',
        'destructive',
        'destructiveOutline',
        'transparent',
      ],
    },
    size: {
      control: 'select',
      options: ['xs', 'sm', 'md', 'lg', 'xl'],
    },
    rounded: {
      control: 'select',
      options: ['none', 'sm', 'rounded', 'md', 'lg', 'xl', 'full'],
    },
    children: { control: false },
    ref: { control: false, table: { disable: true } },
    asChild: { control: false, table: { disable: true } },
  },
} satisfies Meta<typeof IconButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {};

export const Variants: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-3">
      <IconButton {...args} aria-label="Add" variant="primary">
        <Plus />
      </IconButton>
      <IconButton {...args} aria-label="Edit" variant="secondary">
        <Pencil />
      </IconButton>
      <IconButton {...args} aria-label="Edit" variant="outline">
        <Pencil />
      </IconButton>
      <IconButton {...args} aria-label="Edit" variant="tertiary">
        <Pencil />
      </IconButton>
      <IconButton {...args} aria-label="Delete" variant="destructive">
        <Trash2 />
      </IconButton>
      <IconButton {...args} aria-label="Delete" variant="destructiveOutline">
        <Trash2 />
      </IconButton>
    </div>
  ),
};

export const Sizes: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-3">
      <IconButton {...args} size="xs" />
      <IconButton {...args} size="sm" />
      <IconButton {...args} size="md" />
      <IconButton {...args} size="lg" />
      <IconButton {...args} size="xl" />
    </div>
  ),
};

export const Loading: Story = {
  args: { isLoading: true },
};

export const Disabled: Story = {
  args: { disabled: true },
};
