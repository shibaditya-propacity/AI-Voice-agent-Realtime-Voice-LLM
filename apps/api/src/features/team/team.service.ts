import { prisma } from '../../lib/prisma';

export async function getTeamMembers() {
  const members = await prisma.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  return members.map((m) => ({
    ...m,
    role: m.role === 'ADMIN' ? 'admin' : 'member',
  }));
}

export async function getTeamStats() {
  const [total, admins, managers] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { role: 'ADMIN' } }),
    prisma.user.count({ where: { role: 'MANAGER' } }),
  ]);
  return { total, admins, managers };
}
