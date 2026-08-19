import type { Meta, StoryObj } from '@storybook/react-vite';
import { CircularProgress } from '.';

const meta = {
  title: 'Components/CircularProgress',
  component: CircularProgress,
  tags: ['autodocs'],
  args: {
    value: 50,
    max: 100,
    variant: 'primary',
    size: 40,
    strokeWidth: 2.5,
  },
  argTypes: {
    value: {
      control: { type: 'range', min: 0, max: 100, step: 1 },
    },
    max: {
      control: { type: 'number', min: 1 },
    },
    variant: {
      control: 'select',
      options: ['primary', 'secondary'],
    },
    size: {
      control: { type: 'range', min: 16, max: 160, step: 2 },
    },
    strokeWidth: {
      control: { type: 'range', min: 1, max: 12, step: 0.5 },
    },
    children: { control: false },
    ref: { control: false, table: { disable: true } },
  },
} satisfies Meta<typeof CircularProgress>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: { value: 0 },
};

export const Half: Story = {
  args: { value: 50 },
};

export const Full: Story = {
  args: { value: 100 },
};

export const Variants: Story = {
  render: (args) => (
    <div className="flex items-center gap-6">
      <CircularProgress {...args} variant="primary" />
      <CircularProgress {...args} variant="secondary" />
    </div>
  ),
};

export const WithLabel: Story = {
  args: {
    size: 64,
    value: 75,
    children: <span className="text-ink-body text-xs">75%</span>,
  },
};
