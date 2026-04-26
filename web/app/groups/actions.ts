"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { api } from "@/lib/api";

export async function createGroupAction(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const group = await api.createGroup(name);
  revalidatePath("/groups");
  redirect(`/groups/${group.id}`);
}

export async function addWalletAction(groupId: string, formData: FormData) {
  const wallet = String(formData.get("wallet") ?? "").trim();
  const label = String(formData.get("label") ?? "").trim();
  if (!wallet) return;
  await api.addWallet(groupId, wallet, label || undefined);
  revalidatePath(`/groups/${groupId}`);
  revalidatePath("/groups");
}

export async function removeWalletAction(groupId: string, wallet: string) {
  await api.removeWallet(groupId, wallet);
  revalidatePath(`/groups/${groupId}`);
  revalidatePath("/groups");
}
