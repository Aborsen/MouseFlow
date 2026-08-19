import type { Meta, StoryObj } from '@storybook/react-vite';
import { FileImage } from 'lucide-react';
import { fn } from 'storybook/test';
import { File } from '.';

/**
 * `File` is a compact file chip: leading icon, name + optional size, and a
 * trailing slot that switches on state — a spinner while loading, retry +
 * dismiss on error, or a lone dismiss button when only `onDismiss` is set.
 */
const meta = {
  title: 'Components/File',
  component: File,
  tags: ['autodocs'],
  args: {
    name: 'report.pdf',
    fileSize: '1.2 MB',
    isLoading: false,
    isError: false,
    onDismiss: fn(),
  },
  argTypes: {
    name: { control: 'text' },
    fileSize: { control: 'text' },
    icon: { control: false },
    rightSlot: { control: false },
    onClick: { control: false },
    onDismiss: { control: false },
    onRetry: { control: false },
  },
} satisfies Meta<typeof File>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <div className="w-72">
      <File {...args} />
    </div>
  ),
};

/** No handlers → no trailing controls, just the chip. */
export const NameOnly: Story = {
  args: { fileSize: undefined, onDismiss: undefined },
  render: (args) => (
    <div className="w-72">
      <File {...args} />
    </div>
  ),
};

export const Loading: Story = {
  args: { isLoading: true },
  render: (args) => (
    <div className="w-72">
      <File {...args} />
    </div>
  ),
};

/** Error state shows retry + dismiss when both handlers are provided. */
export const ErrorState: Story = {
  args: { isError: true, onRetry: fn(), onDismiss: fn() },
  render: (args) => (
    <div className="w-72">
      <File {...args} />
    </div>
  ),
};

export const Clickable: Story = {
  args: { onClick: fn() },
  render: (args) => (
    <div className="w-72">
      <File {...args} />
    </div>
  ),
};

export const CustomIcon: Story = {
  args: {
    name: 'photo.png',
    fileSize: '820 KB',
    icon: <FileImage className="size-6 text-brand-tertiary" />,
  },
  render: (args) => (
    <div className="w-72">
      <File {...args} />
    </div>
  ),
};
