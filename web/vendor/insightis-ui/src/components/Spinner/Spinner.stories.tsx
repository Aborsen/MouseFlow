import type { Meta, StoryObj } from '@storybook/react-vite';
import { Spinner } from '.';

const meta = {
  title: 'Components/Spinner',
  component: Spinner,
  tags: ['autodocs'],
  args: {
    size: 'sm',
    color: 'primary',
  },
  argTypes: {
    size: {
      control: 'select',
      options: ['xs', 'sm', 'md', 'lg', 'xl'],
    },
    color: {
      control: 'select',
      options: [
        'primary',
        'secondary',
        'muted',
        'accent',
        'success',
        'destructive',
        'warning',
        'white',
        'inherit',
      ],
    },
    ref: { control: false, table: { disable: true } },
  },
} satisfies Meta<typeof Spinner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Sizes: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-6">
      <Spinner {...args} size="xs" />
      <Spinner {...args} size="sm" />
      <Spinner {...args} size="md" />
      <Spinner {...args} size="lg" />
      <Spinner {...args} size="xl" />
    </div>
  ),
};

export const Colors: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-6">
      <Spinner {...args} color="primary" />
      <Spinner {...args} color="secondary" />
      <Spinner {...args} color="muted" />
      <Spinner {...args} color="accent" />
      <Spinner {...args} color="success" />
      <Spinner {...args} color="destructive" />
      <Spinner {...args} color="warning" />
    </div>
  ),
};
