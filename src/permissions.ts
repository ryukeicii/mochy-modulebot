// whether a member can see a channel, worked out the way discord does it, so "can see the paid forum" means the same here as in discord

const ViewChannel = 1n << 10n;
const Administrator = 1n << 3n;

export interface Role {
  id: string;
  permissions: string;
}

export interface Overwrite {
  id: string;
  // 0 a role, 1 a member
  type: number;
  allow: string;
  deny: string;
}

export interface GuildFacts {
  id: string;
  ownerId: string;
  roles: Role[];
}

export function canView(guild: GuildFacts, userId: string, memberRoles: string[], overwrites: Overwrite[]): boolean {
  if (userId === guild.ownerId) return true;
  const byId = new Map(guild.roles.map((role) => [role.id, BigInt(role.permissions)]));
  // the @everyone role has the guild's own id
  let perms = byId.get(guild.id) ?? 0n;
  for (const role of memberRoles) perms |= byId.get(role) ?? 0n;
  if (perms & Administrator) return true;
  const everyone = overwrites.find((o) => o.type === 0 && o.id === guild.id);
  if (everyone) perms = (perms & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  let allow = 0n;
  let deny = 0n;
  for (const o of overwrites) {
    if (o.type === 0 && o.id !== guild.id && memberRoles.includes(o.id)) {
      allow |= BigInt(o.allow);
      deny |= BigInt(o.deny);
    }
  }
  perms = (perms & ~deny) | allow;
  const own = overwrites.find((o) => o.type === 1 && o.id === userId);
  if (own) perms = (perms & ~BigInt(own.deny)) | BigInt(own.allow);
  return (perms & ViewChannel) !== 0n;
}
