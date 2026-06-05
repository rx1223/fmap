import { trpc } from "../trpc";

export function UserAdminPage() {
  const create = trpc.user.create.useMutation();
  const remove = trpc.user.remove.useMutation();
  const { data } = trpc.user.current.useQuery();
  return (
    <div>
      {data?.name}
      <button onClick={() => create.mutate({ name: "x" })}>Add</button>
      <button onClick={() => remove.mutate()}>Delete</button>
    </div>
  );
}
