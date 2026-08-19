import type { Meta, StoryObj } from '@storybook/react-vite';
import { Skeleton } from '.';

const meta = {
  title: 'Components/Skeleton',
  component: Skeleton,
  tags: ['autodocs'],
  args: {
    animation: 'shimmer',
    rounded: 'md',
    isLoaded: false,
    className: 'h-4 w-48',
  },
  argTypes: {
    animation: {
      control: 'select',
      options: ['shimmer', 'pulse', 'none'],
    },
    rounded: {
      control: 'select',
      options: ['none', 'sm', 'md', 'lg', 'xl', 'full'],
    },
    children: { control: false },
    ref: { control: false, table: { disable: true } },
  },
} satisfies Meta<typeof Skeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Animations: Story = {
  render: (args) => (
    <div className="flex flex-col gap-4">
      <Skeleton {...args} animation="shimmer" className="h-4 w-48" />
      <Skeleton {...args} animation="pulse" className="h-4 w-48" />
      <Skeleton {...args} animation="none" className="h-4 w-48" />
    </div>
  ),
};

export const Shapes: Story = {
  render: (args) => (
    <div className="flex items-center gap-4">
      <Skeleton {...args} rounded="full" className="size-12" />
      <div className="flex flex-col gap-2">
        <Skeleton {...args} rounded="md" className="h-4 w-40" />
        <Skeleton {...args} rounded="md" className="h-4 w-28" />
      </div>
    </div>
  ),
};

export const WithContent: Story = {
  args: {
    isLoaded: false,
    children: <span className="text-ink-body">Loaded content goes here</span>,
  },
};

export const Loaded: Story = {
  args: {
    isLoaded: true,
    children: <span className="text-ink-body">Loaded content goes here</span>,
  },
};
