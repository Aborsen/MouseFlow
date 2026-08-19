import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  Bot,
  Files,
  Home,
  MessageSquare,
  Search,
  Settings,
} from 'lucide-react';
import { Typography } from '../Typography';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarNavigationItems,
  SidebarProvider,
  SidebarTrigger,
} from '.';
import type { NavigationElement } from './types';

// Realistic app navigation: single links + a collapsible group with sub-items.
const navigation: NavigationElement[] = [
  { id: 'home', title: 'Home', icon: Home, url: '/' },
  { id: 'search', title: 'Search', icon: Search, url: '/search' },
  {
    id: 'chats',
    title: 'Chats',
    icon: MessageSquare,
    defaultOpen: true,
    items: [
      { id: 'c1', title: 'Onboarding questions', url: '/chats/1' },
      { id: 'c2', title: 'Quarterly metrics review', url: '/chats/2' },
      { id: 'c3', title: 'Bug triage thread', url: '/chats/3' },
    ],
    viewAll: { id: 'chats-all', title: 'View all', url: '/chats' },
  },
  {
    id: 'agents',
    title: 'Agents',
    icon: Bot,
    emptyMessage: 'No agents yet',
    items: [],
  },
  { id: 'files', title: 'Files', icon: Files, url: '/files' },
];

const meta = {
  title: 'Components/Sidebar',
  component: Sidebar,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
  args: {
    side: 'left',
    variant: 'sidebar',
    collapsible: 'offcanvas',
  },
  argTypes: {
    side: { control: 'select', options: ['left', 'right'] },
    variant: {
      control: 'select',
      options: ['sidebar', 'floating', 'inset'],
    },
    collapsible: {
      control: 'select',
      options: ['offcanvas', 'icon', 'none'],
    },
    sheetClassname: { control: false },
    className: { control: false },
    children: { control: false },
    ref: { control: false, table: { disable: true } },
  },
  // Desktop sidebar only renders at >=lg. Give the canvas a fixed height so the
  // fixed-position panel and inset content lay out correctly.
  decorators: [
    (Story) => (
      <div className="h-svh min-h-[32rem] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Sidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Expanded: Story = {
  render: (args) => (
    <SidebarProvider defaultOpen>
      <Sidebar {...args}>
        <SidebarHeader>
          <Typography variant="h5">Insightis</Typography>
        </SidebarHeader>
        <SidebarContent>
          <SidebarNavigationItems items={navigation} />
        </SidebarContent>
        <SidebarFooter>
          <div className="flex items-center gap-2 px-2">
            <Settings className="size-4" />
            <Typography variant="span" textColor="secondary">
              Settings
            </Typography>
          </div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <div className="flex items-center gap-2 p-4">
          <SidebarTrigger variant="ghost" />
          <Typography variant="h4">Dashboard</Typography>
        </div>
      </SidebarInset>
    </SidebarProvider>
  ),
};

// `collapsible="icon"` + collapsed provider state minimises the sidebar to an
// icon rail with tooltips on hover.
export const CollapsedIcon: Story = {
  args: { collapsible: 'icon' },
  render: (args) => (
    <SidebarProvider defaultOpen={false}>
      <Sidebar {...args}>
        <SidebarHeader>
          <Typography variant="h5">Insightis</Typography>
        </SidebarHeader>
        <SidebarContent>
          <SidebarNavigationItems items={navigation} />
        </SidebarContent>
      </Sidebar>
      <SidebarInset>
        <div className="flex items-center gap-2 p-4">
          <SidebarTrigger variant="ghost" />
          <Typography variant="h4">Dashboard</Typography>
        </div>
      </SidebarInset>
    </SidebarProvider>
  ),
};

export const FloatingVariant: Story = {
  args: { variant: 'floating' },
  render: (args) => (
    <SidebarProvider defaultOpen>
      <Sidebar {...args}>
        <SidebarHeader>
          <Typography variant="h5">Insightis</Typography>
        </SidebarHeader>
        <SidebarContent>
          <SidebarNavigationItems items={navigation} />
        </SidebarContent>
      </Sidebar>
      <SidebarInset>
        <div className="flex items-center gap-2 p-4">
          <SidebarTrigger variant="ghost" />
          <Typography variant="h4">Dashboard</Typography>
        </div>
      </SidebarInset>
    </SidebarProvider>
  ),
};

export const InsetVariant: Story = {
  args: { variant: 'inset', collapsible: 'icon' },
  render: (args) => (
    <SidebarProvider defaultOpen>
      <Sidebar {...args}>
        <SidebarHeader>
          <Typography variant="h5">Insightis</Typography>
        </SidebarHeader>
        <SidebarContent>
          <SidebarNavigationItems items={navigation} />
        </SidebarContent>
      </Sidebar>
      <SidebarInset>
        <div className="flex items-center gap-2 p-4">
          <SidebarTrigger variant="ghost" />
          <Typography variant="h4">Inset content</Typography>
        </div>
      </SidebarInset>
    </SidebarProvider>
  ),
};
