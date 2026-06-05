import axios from "axios";

export function UserAdminPage() {
  const create = () => axios.post("/api/users", { name: "x" }); // POST /users
  const remove = (id: string) => axios.delete(`/api/users/${id}`); // DELETE /users/{id}
  return (
    <div>
      <button onClick={() => create()}>Add</button>
      <button onClick={() => remove("1")}>Delete</button>
    </div>
  );
}
