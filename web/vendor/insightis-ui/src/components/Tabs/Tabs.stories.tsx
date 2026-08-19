import type { Meta, StoryObj } from '@storybook/react-vite';
import { MessageSquare, Settings, Users } from 'lucide-react';
import { Typography } from '../Typography';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '.';

const meta = {
  title: 'Components/Tabs',
  component: Tabs,
  tags: ['autodocs'],
  args: {
    defaultValue: 'chats',
    size: 'md',
  },
  argTypes: {
    size: {
      control: 'select',
      options: ['sm', 'md'],
    },
    defaultValue: { control: false },
  },
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <Tabs {...args}>
      <TabsList>
        <TabsTrigger value="chats">Chats</TabsTrigger>
        <TabsTrigger value="members">Members</TabsTrigger>
        <TabsTrigger value="settings">Settings</TabsTrigger>
      </TabsList>
      <TabsContent value="chats">
        <Typography>Chats panel content</Typography>
      </TabsContent>
      <TabsContent value="members">
        <Typography>Members panel content</Typography>
      </TabsContent>
      <TabsContent value="settings">
        <Typography>Settings panel content</Typography>
      </TabsContent>
    </Tabs>
  ),
};

export const WithIcons: Story = {
  render: (args) => (
    <Tabs {...args}>
      <TabsList>
        <TabsTrigger value="chats">
          <MessageSquare className="size-4" />
          Chats
        </TabsTrigger>
        <TabsTrigger value="members">
          <Users className="size-4" />
          Members
        </TabsTrigger>
        <TabsTrigger value="settings">
          <Settings className="size-4" />
          Settings
        </TabsTrigger>
      </TabsList>
      <TabsContent value="chats">
        <Typography>Chats panel content</Typography>
      </TabsContent>
      <TabsContent value="members">
        <Typography>Members panel content</Typography>
      </TabsContent>
      <TabsContent value="settings">
        <Typography>Settings panel content</Typography>
      </TabsContent>
    </Tabs>
  ),
};

export const WithDisabledTab: Story = {
  render: (args) => (
    <Tabs {...args}>
      <TabsList>
        <TabsTrigger value="chats">Chats</TabsTrigger>
        <TabsTrigger value="members" disabled>
          Members
        </TabsTrigger>
        <TabsTrigger value="settings">Settings</TabsTrigger>
      </TabsList>
      <TabsContent value="chats">
        <Typography>Chats panel content</Typography>
      </TabsContent>
      <TabsContent value="settings">
        <Typography>Settings panel content</Typography>
      </TabsContent>
    </Tabs>
  ),
};

export const Small: Story = {
  args: { size: 'sm' },
  render: (args) => (
    <Tabs {...args}>
      <TabsList>
        <TabsTrigger value="chats">Chats</TabsTrigger>
        <TabsTrigger value="members">Members</TabsTrigger>
      </TabsList>
      <TabsContent value="chats">
        <Typography>Chats panel content</Typography>
      </TabsContent>
      <TabsContent value="members">
        <Typography>Members panel content</Typography>
      </TabsContent>
    </Tabs>
  ),
};
