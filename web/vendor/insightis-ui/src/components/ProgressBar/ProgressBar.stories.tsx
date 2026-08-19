import type { Meta, StoryObj } from '@storybook/react-vite';
import { ProgressBar } from '.';

const meta = {
  title: 'Components/ProgressBar',
  component: ProgressBar,
  tags: ['autodocs'],
  args: {
    value: 50,
    max: 100,
    variant: 'primary',
    size: 'md',
    rounded: 'lg',
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
      options: ['primary', 'tertiary', 'green', 'attention', 'destructive'],
    },
    size: {
      control: 'select',
      options: ['md', 'lg'],
    },
    rounded: {
      control: 'select',
      options: ['lg', 'full'],
    },
    ref: { control: false, table: { disable: true } },
  },
  decorators: [
    (Story) => (
      <div className="w-72">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProgressBar>;

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

export const States: Story = {
  render: (args) => (
    <div className="flex w-72 flex-col gap-4">
      <ProgressBar {...args} value={0} />
      <ProgressBar {...args} value={50} />
      <ProgressBar {...args} value={100} />
    </div>
  ),
};
