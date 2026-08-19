import type { Meta, StoryObj } from '@storybook/react-vite';
import { Avatar, AvatarFallback, AvatarImage } from '.';

const meta = {
  title: 'Components/Avatar',
  component: Avatar,
  tags: ['autodocs'],
  args: {
    size: 'md',
    rounded: 'full',
  },
  argTypes: {
    size: {
      control: 'select',
      options: ['xxs', 'xs', 'sm', 'md', 'lg', 'xl'],
    },
    rounded: {
      control: 'select',
      options: ['none', 'sm', 'md', 'lg', 'xl', 'full'],
    },
    ref: { control: false, table: { disable: true } },
  },
} satisfies Meta<typeof Avatar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithFallback: Story = {
  render: (args) => (
    <Avatar {...args}>
      <AvatarImage src="/broken-link.png" alt="Jane Doe" />
      <AvatarFallback>JD</AvatarFallback>
    </Avatar>
  ),
};

export const Sizes: Story = {
  render: (args) => (
    <div className="flex items-center gap-3">
      {(['xxs', 'xs', 'sm', 'md', 'lg', 'xl'] as const).map((size) => (
        <Avatar {...args} key={size} size={size}>
          <AvatarFallback>JD</AvatarFallback>
        </Avatar>
      ))}
    </div>
  ),
};

export const Rounding: Story = {
  render: (args) => (
    <div className="flex items-center gap-3">
      {(['none', 'sm', 'md', 'lg', 'xl', 'full'] as const).map((rounded) => (
        <Avatar {...args} key={rounded} rounded={rounded}>
          <AvatarFallback>JD</AvatarFallback>
        </Avatar>
      ))}
    </div>
  ),
};
