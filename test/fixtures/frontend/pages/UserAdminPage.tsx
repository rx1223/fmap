import { useQuery, useMutation, gql } from "@apollo/client";
import { CREATE_USER, DELETE_USER } from "../queries";

// Local inline const — resolved within this file.
const CURRENT_USER = gql`
  query CurrentUser {
    currentUser {
      id
      name
    }
  }
`;

export function UserAdminPage() {
  const { data } = useQuery(CURRENT_USER);
  const [create] = useMutation(CREATE_USER);
  const [remove] = useMutation(DELETE_USER);
  return (
    <div>
      {data?.currentUser?.name}
      <button onClick={() => create()}>Add</button>
      <button onClick={() => remove()}>Delete</button>
    </div>
  );
}
